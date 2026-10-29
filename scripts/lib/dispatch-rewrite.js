/*
 * dispatch-rewrite.js — the dispatcher core that makes every change this repo
 * makes to an `Agent` dispatch's input, in one rewrite, and hands the session
 * the dispatch rules (#515, #2013). Its production ports, the artefact's path
 * and its directory, are lib/dispatch-rewrite-host.js; burn mode's marker is
 * read through the shared ctx.env and ctx.isFile.
 *
 * ONE REWRITE, NOT ONE PER CHANGE. Two hooks each returning `updatedInput` on
 * one call race, the last to finish winning and the other's change lost
 * (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/hook-ordering-plugin-vs-native.md,
 * anthropics/claude-code#83353). So each change is a pure transform — call in,
 * call and a note out, or null — and `rewrite` applies them in turn to one
 * input. Burn mode's table is lib/burn-mode.js's, its switch
 * scripts/burn-mode.sh's. The marker is one per MACHINE, so an `off` run
 * anywhere ends the remap everywhere.
 *
 * What it does to a dispatch:
 *   * a usable `Artefact:` line is left exactly as written;
 *   * an unfilled one (`Artefact: TBD`, `<path>`, `none`) has its value
 *     replaced in place; otherwise the line is appended. Either way two
 *     instructions follow it: append findings as they land, and search a long
 *     source on disk rather than read it whole (#1789). The path is absolute:
 *     <project root>/.claude/tmp/agents/<description slug>-<8 hex>.md;
 *   * the session is told the path and the watcher command to watch it with,
 *     the prompt's own artefact path where it names one; a dispatch with no
 *     artefact to watch is told to end the turn;
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
 * IMPLICIT:  adds an `Artefact:` line to a dispatch prompt naming no usable one, and while burn mode is on moves a `sonnet` dispatch to `opus` — neither asked for by the session dispatching; denies a dispatch made from inside a subagent.
 * JUSTIFIED: convenience — the session would have added the line itself after a refusal, at the cost of re-issuing the whole prompt (#482); burn mode's remap is the founder's own switch (#355).
 * DEFEAT:    none for the line — name a real path in the prompt and it is left alone; `scripts/burn-mode.sh off` ends the remap; none for the subagent deny short of dispatching from the parent.
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
 * (HOME unset or relative) leaves the model unmapped and still supplies the
 * line. A rule fragment the store cannot give refuses the dispatch, as an
 * injection's store fault does (mantahostels#1762).
 */

const path = require("node:path");
const { caught } = require("./caught.js");
const { injectArtefact, buildWatchNote } = require("./dispatch-artefact.js");
const { tierDeparture, untrackedSearch } = require("./dispatch-rules.js");
const { shellQuote } = require("./sh-quote.js");

/**
 * @typedef {Pick<import("./guard-dispatch.js").CoreContext, "agent" |
 *   "corePaths" | "env" | "input" | "isFile" | "log" | "ruleText"> & {
 *   artefactFile: (description: unknown) => string,
 *   makeDir: (dir: string) => boolean,
 * }} RewriteContext a fresh artefact path for a dispatch's description, and
 *   the making of a directory, false where it could not be made
 * @typedef {import("./guard-entry.js").Injection} Injection
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
 * @param {{file: string, burn: boolean}} opts the artefact path to supply
 *   where one is needed, and whether burn mode is on
 * @returns {null | {artefact: string | null, rules: string[], context: string, updatedInput?: Record<string, unknown>}}
 *   the artefact supplied, if any; the ids of the rules it tripped (#2013);
 *   the notes, joined; and the call as rewritten, where it changed
 */
function rewrite(input, { file, burn }) {
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
		notes.push(buildWatchNote(call, watchCommand) ?? END_TURN);
	}
	// Loaded only while burn mode is on, so a broken table costs the remap and
	// never the artefact line.
	const remapped = burn ? require("./burn-mode.js").remapModel(call) : null;
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
 * Whether burn mode's marker is present. The table is loaded here, so a broken
 * one costs the remap and never the line; a marker that cannot be placed
 * leaves the model unmapped. Either is recorded.
 * @param {RewriteContext} ctx
 */
function burnOn(ctx) {
	let marker;
	try {
		marker = require("./burn-mode.js").markerPath(ctx.env);
	} catch (e) {
		ctx.log(
			caught(e).code === "MODULE_NOT_FOUND"
				? "lib/burn-mode.js unreadable — burn mode left this dispatch unmapped"
				: "burn-mode marker path unresolved — burn mode left this dispatch unmapped",
		);
		return false;
	}
	return ctx.isFile(marker);
}

const field = "prompt";
const noun = "agent dispatch";

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
		out = rewrite(ctx.input, {
			file: ctx.artefactFile(ctx.input.description),
			burn: burnOn(ctx),
		});
	} catch (e) {
		ctx.log(
			`dispatch rewrite threw — dispatch left as written: ${caught(e).message}`,
		);
		return null;
	}
	if (!out) return null;
	/* The directory is made here so a subagent appending through a shell
	 * redirect finds it; the Write tool makes its own parents, so the line
	 * still goes out without it. */
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

module.exports = { decide, field, noun };
