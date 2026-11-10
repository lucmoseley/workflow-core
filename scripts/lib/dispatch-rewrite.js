/*
 * dispatch-rewrite.js — the dispatcher core that makes every change this repo
 * makes to an `Agent` dispatch's input, in one rewrite, and hands the session
 * the dispatch rules (#515, #2013). Its production ports, the artefact's path
 * and its directory, are lib/dispatch-rewrite-host.js.
 *
 * ONE REWRITE, NOT ONE PER CHANGE. Two hooks each returning `updatedInput` on
 * one call race, the last to finish winning and the other's change lost
 * (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/hook-ordering-plugin-vs-native.md,
 * anthropics/claude-code#83353). So each change is a pure transform — call in,
 * call and a note out, or null — and `rewrite` applies them in turn to one
 * input. The model table, standing layer and burn layer both, is
 * lib/burn-mode.js's, burn mode's switch scripts/burn-mode.sh's. The marker is
 * one per MACHINE, so an `off` run anywhere ends the burn remap everywhere.
 *
 * What it does to a dispatch:
 *   * a usable `Artefact:` line is left exactly as written;
 *   * an unfilled one (`Artefact: TBD`, `<path>`, `none`) has its value
 *     replaced in place; otherwise the line is appended. Either way two
 *     instructions follow it: append findings as they land, and search a long
 *     source on disk rather than read it whole (#1789). The path is absolute:
 *     <project root>/.claude/tmp/agents/<description slug>-<8 hex>.md;
 *   * the session is told the path and the watcher command to watch it with,
 *     the prompt's own artefact path where it names one, a leading `~/` read
 *     against HOME; a dispatch with no artefact to watch is told to end the
 *     turn;
 *   * the model and effort move through lib/burn-mode.js's table: always
 *     `sonnet` to Haiku, every Haiku call at xhigh, and while burn mode is on
 *     Haiku to Opus and Opus to Fable, each at medium, an overflow seat's
 *     session excepted (#4919);
 *   * a named model the effort guide routes away from (lib/dispatch-rules.js)
 *     gets rule:dispatch-tier, and a "search the repo" prompt naming no tracker
 *     rule:dispatch-search-tracker, each fragment once a session;
 *   * a dispatch from inside a subagent, `agent_id` on the payload, is DENIED
 *     with rule:dispatch-grandchild;
 *   * `statusline-setup`, which has no tool that can create a file, and
 *     Explore and Plan, read-only by their own instructions (#565), are exempt
 *     by name (lib/dispatch-artefact.js's EXEMPT_AGENT_TYPES), and so is an
 *     `isolation: "remote"` dispatch, which cannot write a local path. A fork
 *     is not.
 *
 * The subject is the dispatch's `prompt`, a field the harness requires of
 * every `Agent` and `Task` call; the core judges the whole `tool_input`.
 *
 * IMPLICIT:  adds an `Artefact:` line to a dispatch prompt naming no usable one; moves a `sonnet` dispatch to `haiku` and runs every `haiku` one at xhigh; while burn mode is on moves `haiku` to `opus` and `opus` to `fable`, each at medium — none asked for by the session dispatching; denies a dispatch made from inside a subagent.
 * JUSTIFIED: convenience — the session would have added the line itself after a refusal, at the cost of re-issuing the whole prompt (#482); the model table is the founder's own ruling, and burn mode his own switch (#4919).
 * DEFEAT:    none for the line — name a real path in the prompt and it is left alone; `scripts/burn-mode.sh off` ends the burn remap; none for the subagent deny short of dispatching from the parent.
 *
 * LIMITS. The line is a PROMISE and nothing verifies it is kept: the agent may
 * never write the file, or write it only at the end. The model field is
 * rewritten and the prompt never is, so a prompt telling the agent which model
 * it runs on now lies. It sees an `Agent` or `Task` call and nothing else, so
 * a subagent launched any other way is untouched. The two injected rules
 * arrive with the dispatch's result, after the agent has launched: they
 * correct the next dispatch, never the one that tripped them. The search
 * detector is lexical, so a search phrased without its verbs, or a tracker
 * named only as "the issues", passes unjudged. The harness applies
 * `updatedInput` with an `allow`, which runs the call as rewritten; a denial
 * from a sibling core or hook on this matcher still wins, and so does a
 * settings `deny` or `ask` rule, which a hook `allow` never overrides. Whether
 * an `allow` also skips the auto-mode classifier is undocumented (#492). A
 * transform that throws leaves the dispatch as written, recorded as a
 * fail-open (mantahostels#103 §6); a burn-mode marker that cannot be placed
 * (HOME unset or relative) applies the standing layer alone and still
 * supplies the line; an unreadable table leaves the model as written. A rule fragment the store cannot give refuses the dispatch, as an
 * injection's store fault does (mantahostels#1762).
 */

const path = require("node:path");
const { caught } = require("./caught.js");
const { injectArtefact, buildWatchNote } = require("./dispatch-artefact.js");
const { tierDeparture, untrackedSearch } = require("./dispatch-rules.js");
const { shellQuote } = require("./sh-quote.js");

/**
 * @typedef {Pick<import("./core-contract.js").CoreContext, "agent" |
 *   "corePaths" | "env" | "input" | "isFile" | "log" | "ruleText" | "session"> & {
 *   artefactFile: (description: unknown) => string,
 *   makeDir: (dir: string) => boolean,
 * }} RewriteContext a fresh artefact path for a dispatch's description, and
 *   the making of a directory, false where it could not be made
 * @typedef {import("./guard-entry.js").Injection} Injection
 * @typedef {Pick<typeof import("./burn-mode.js"), "isOverflowSession" | "markerPath" | "remapModel">} ModelTable
 */

// Resolved from this file, so an adopter is handed the plugin's copy (#541).
const WATCHER = path.resolve(__dirname, "..", "watch-artefact.js");

/**
 * The watch docs/agents/guard-registry.md §Subagent dispatch prescribes, for one artefact. 120 s
 * is a judgement, never measured against a band's timings.
 * @param {string} file
 * @returns {string}
 */
function watchCommand(file) {
	return `node ${shellQuote(WATCHER)} ${shellQuote(file)} 120`;
}

/**
 * The rules a dispatch can trip, in emission order: every dispatch injects
 * both and skips the ones it did not trip. The ids' one spelling, a literal
 * where lib/rule-emission.js reads it.
 */
const EMITTED = { injectRules: ["dispatch-tier", "dispatch-search-tracker"] };
const [TIER_RULE = "", SEARCH_RULE = ""] = EMITTED.injectRules;

/** Told where no artefact is watched: an exempt or remote agent. */
const END_TURN =
	"While this agent runs, end the turn: its completion notification wakes this session, so a poll learns nothing.";

/**
 * Every change to one `Agent` call, and what the session is told of it.
 *
 * @param {unknown} input the tool_input object
 * @param {{file: string, burn: boolean, home?: string, table: ModelTable | null}} opts
 *   the artefact path to supply where one is needed, whether burn mode is on,
 *   the home directory a prompt's `~/` artefact names, and the model table
 * @returns {null | {artefact: string | null, rules: string[], context: string, updatedInput?: Record<string, unknown>}}
 *   the artefact supplied, if any; the ids of the rules it tripped (#2013);
 *   the notes, joined; and the call as rewritten, where it changed
 */
function rewrite(input, { file, burn, home, table }) {
	if (input === null || typeof input !== "object") return null;
	const asked = /** @type {Record<string, unknown>} */ (input);
	let call = asked;
	/** @type {string[]} */
	const notes = [];
	/** @type {string[]} */
	const rules = [];
	let artefact = null;

	const artefacted = injectArtefact(call, file, watchCommand);
	if (artefacted) {
		call = artefacted.input;
		notes.push(artefacted.note);
		artefact = file;
	} else {
		notes.push(buildWatchNote(call, watchCommand, home) ?? END_TURN);
	}
	const remapped = table ? table.remapModel(call, burn) : null;
	if (remapped) {
		call = remapped.input;
		notes.push(remapped.note);
	}

	const tier = tierDeparture(asked, burn);
	if (tier) {
		notes.push(tier);
		rules.push(TIER_RULE);
	}
	const search = untrackedSearch(asked);
	if (search) {
		notes.push(search);
		rules.push(SEARCH_RULE);
	}

	return {
		artefact,
		rules,
		context: notes.join("\n\n"),
		...(call === asked ? {} : { updatedInput: call }),
	};
}

/**
 * The model table, loaded per dispatch so a broken one costs the remap and
 * never the line.
 * @param {RewriteContext} ctx
 * @returns {ModelTable | null}
 */
function loadTable(ctx) {
	try {
		const {
			isOverflowSession,
			markerPath,
			remapModel,
		} = require("./burn-mode.js");
		if (
			typeof isOverflowSession !== "function" ||
			typeof markerPath !== "function" ||
			typeof remapModel !== "function"
		)
			throw new Error("its exports are not functions");
		return { isOverflowSession, markerPath, remapModel };
	} catch (e) {
		ctx.log(
			`lib/burn-mode.js unreadable — the model table left this dispatch unmapped: ${caught(e).message}`,
		);
		return null;
	}
}

/**
 * Whether burn mode's layer applies: its marker present, on a session not on
 * an overflow seat (#4919). A marker that cannot be placed reads as off,
 * recorded, so the standing layer still applies.
 * @param {ModelTable} table
 * @param {RewriteContext} ctx
 */
function burnOn(table, ctx) {
	if (table.isOverflowSession(ctx.env, ctx.session)) return false;
	let marker;
	try {
		marker = table.markerPath(ctx.env);
	} catch {
		ctx.log(
			"burn-mode marker path unresolved — burn mode left this dispatch unmapped",
		);
		return false;
	}
	return ctx.isFile(marker);
}

/**
 * @param {string} _prompt the dispatch's prompt; the whole call is ctx.input
 * @param {RewriteContext} ctx
 * @returns {import("./guard-entry.js").Deny
 *   | (Injection & Required<Pick<Injection, "skip" | "prelude">>
 *     & { updatedInput?: Record<string, unknown> })
 *   | null}
 */
function decide(_prompt, ctx) {
	// A subagent's own calls carry `agent_id`; the parent's never do.
	if (ctx.agent)
		return { deny: ctx.corePaths(ctx.ruleText("dispatch-grandchild")) };
	let out;
	try {
		const table = loadTable(ctx);
		out = rewrite(ctx.input, {
			file: ctx.artefactFile(ctx.input.description),
			burn: table ? burnOn(table, ctx) : false,
			home: ctx.env.HOME,
			table,
		});
	} catch (e) {
		ctx.log(
			`dispatch rewrite threw — dispatch left as written: ${caught(e).message}`,
		);
		return null;
	}
	if (!out) return null;
	/* The directory is made here so a subagent appending through a shell
	 * redirect finds it. */
	if (out.artefact && !ctx.makeDir(path.dirname(out.artefact)))
		ctx.log(
			"artefact directory not made — the agent's first shell append will fail",
		);
	const tripped = new Set(out.rules);
	return {
		...EMITTED,
		skip: EMITTED.injectRules.filter((id) => !tripped.has(id)),
		prelude: out.context,
		...(out.updatedInput ? { updatedInput: out.updatedInput } : {}),
	};
}

module.exports = { decide, field: "prompt", noun: "agent dispatch" };
