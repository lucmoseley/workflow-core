const path = require("node:path");
const { isBackgroundJob } = require("./job-paths.js");
const { caught } = require("./caught.js");
const {
	injectArtefact,
	buildWatchNote,
	JOB_WAIT,
} = require("./dispatch-artefact.js");
const { tierDeparture, untrackedSearch } = require("./dispatch-rules.js");
const { shellQuote } = require("./sh-quote.js");

/**
 * @typedef {Pick<import("./core-contract.js").CoreContext, "agent" |
 * "corePaths" | "env" | "input" | "isFile" | "log" | "ruleText" | "session"> & {
 * artefactFile: (description: unknown) => string,
 * makeDir: (dir: string) => boolean,
 * sessionModel: (session: string) => string,
 * }} RewriteContext
 * @typedef {import("./guard-entry.js").Injection} Injection
 * @typedef {Pick<typeof import("./model-table.js"), "isRoutedAway" | "isOverflowSession" | "remapModel" | "standardRoute">} ModelTable
 */

const WATCHER = path.resolve(__dirname, "..", "watch-artefact.js");

// guess (workflow-core#539): never measured against a band's timings
const WATCH_INTERVAL_S = 120;
// guess (workflow-core#5520): 10 s under rule:job-holds-turn's `timeout 540`
const JOB_CEILING_S = 530;

/**
 * @param {string | null} file
 * @param {boolean} [job]
 * @returns {string}
 */
function watchCommand(file, job = false) {
	const watched = file === null ? "--no-artefact" : shellQuote(file);
	const ceiling = job ? ` ${JOB_CEILING_S}` : "";
	return `node ${shellQuote(WATCHER)} ${watched} ${WATCH_INTERVAL_S}${ceiling} --log <output_file>`;
}

const EMITTED = { injectRules: ["dispatch-tier", "dispatch-search-tracker"] };
const [TIER_RULE = "", SEARCH_RULE = ""] = EMITTED.injectRules;

const END_TURN =
	"While this agent runs, end the turn: its completion notification wakes this session, so a poll learns nothing.";
const HOLD_TURN = `This session is a background job: hold the turn on \`${watchCommand(null, true)}\`, its \`<output_file>\` the one the launch result names, until it exits \`DONE\`. ${JOB_WAIT}`;

/**
 * @param {unknown} input
 * @param {{file: string, burn: boolean, home?: string, inherited?: string, job?: boolean, table: ModelTable | null}} opts
 * @returns {null | {artefact: string | null, rules: string[], context: string, updatedInput?: Record<string, unknown>}}
 */
function rewrite(
	input,
	{ file, burn, home, inherited = "", job = false, table },
) {
	if (input === null || typeof input !== "object") return null;
	const asked = /** @type {Record<string, unknown>} */ (input);
	let call = asked;
	/** @type {string[]} */
	const notes = [];
	/** @type {string[]} */
	const rules = [];
	let artefact = null;

	const artefacted = injectArtefact(call, file, watchCommand, job);
	if (artefacted) {
		call = artefacted.input;
		notes.push(artefacted.note);
		artefact = file;
	} else {
		notes.push(
			buildWatchNote(call, watchCommand, home, job) ??
				(job ? HOLD_TURN : END_TURN),
		);
	}
	const remapped = table ? table.remapModel(call, burn, inherited) : null;
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
 * @param {RewriteContext} ctx
 * @returns {ModelTable | null}
 */
function loadModelTable(ctx) {
	try {
		const {
			isRoutedAway,
			isOverflowSession,
			loadRouting,
			remapModel,
			standardRoute,
		} = require("./model-table.js");
		if (
			typeof isRoutedAway !== "function" ||
			typeof loadRouting !== "function" ||
			typeof isOverflowSession !== "function" ||
			typeof remapModel !== "function" ||
			typeof standardRoute !== "function"
		)
			throw new Error("its exports are not functions");
		loadRouting();
		return { isRoutedAway, isOverflowSession, remapModel, standardRoute };
	} catch (e) {
		ctx.log(
			`lib/model-table.js unreadable — the model table left this dispatch unmapped: ${caught(e).message}`,
		);
		return null;
	}
}

/**
 * @param {ModelTable} table
 * @param {RewriteContext} ctx
 */
function isBurnApplied(table, ctx) {
	if (table.isOverflowSession(ctx.env, ctx.session)) return false;
	let markerPath;
	try {
		({ markerPath } = require("./burn-mode.js"));
		if (typeof markerPath !== "function")
			throw new Error("its markerPath is not a function");
	} catch (e) {
		ctx.log(
			`lib/burn-mode.js unreadable — burn mode left this dispatch unmapped: ${caught(e).message}`,
		);
		return false;
	}
	let marker;
	try {
		marker = markerPath(ctx.env);
	} catch {
		ctx.log(
			"burn-mode marker path unresolved — burn mode left this dispatch unmapped",
		);
		return false;
	}
	return ctx.isFile(marker);
}

/**
 * @param {ModelTable} table
 * @param {string} inherited
 * @param {{ruleText: (id: string) => string}} ctx
 */
function forkDeny(table, inherited, ctx) {
	const to = table.standardRoute(inherited)?.to;
	const rule = ctx.ruleText("dispatch-fable-fork");
	return to
		? `${rule.trimEnd()}\n\nFor this session: \`model: "${to}"\`.\n`
		: rule;
}

/**
 * @param {string} _prompt
 * @param {RewriteContext} ctx
 * @returns {import("./guard-entry.js").Deny
 * | (Injection & Required<Pick<Injection, "skip" | "prelude">>
 * & { updatedInput?: Record<string, unknown> })
 * | null}
 */
function decide(_prompt, ctx) {
	if (ctx.agent)
		return { deny: ctx.corePaths(ctx.ruleText("dispatch-grandchild")) };
	let out;
	try {
		const table = loadModelTable(ctx);
		const burn = table ? isBurnApplied(table, ctx) : false;
		const inherited = table && !burn ? ctx.sessionModel(ctx.session) : "";
		if (
			table?.isRoutedAway(inherited) &&
			String(ctx.input.subagent_type ?? "").trim() === "fork"
		)
			return { deny: ctx.corePaths(forkDeny(table, inherited, ctx)) };
		out = rewrite(ctx.input, {
			file: ctx.artefactFile(ctx.input.description),
			burn,
			home: ctx.env.HOME,
			inherited,
			job: isBackgroundJob(ctx.env),
			table,
		});
	} catch (e) {
		ctx.log(
			`dispatch rewrite threw — dispatch left as written: ${caught(e).message}`,
		);
		return null;
	}
	if (!out) return null;
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
