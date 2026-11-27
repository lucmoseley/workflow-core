const { ruleOrFallback } = require("./guard-verdict.js");
const { parseCommand, unmask, walkCommands } = require("./shell-parse.js");
const { literal, typedWord } = require("./shell-words.js");
const { suiteLaunchKind } = require("./suite-launch.js");
const { caught } = require("./caught.js");

/** @type {import("./suite-launch.js").LaunchPorts} */
const LAUNCH_PORTS = { runners: () => [], isWrapperScript: () => true };

/**
 * @typedef {({ deny?: string, note?: string, why?: string, unread?: string })} Verdict
 * @typedef {object} UnaskedPorts
 * @property {(input: { sessionId: string, cwd: string, command: string }, tree: string) => Verdict} judge
 * @property {(session: string) => import("./in-flight-runs.js").InFlightRun[] | null} inFlight
 * @typedef {import("./kit-context.js").KitContext & UnaskedPorts & { session: string }
 *   & Pick<import("./core-contract.js").CoreContext, "tree">} UnaskedContext
 */

/**
 * @param {string} command
 * @param {import("./shell-parse.js").WalkPorts} ports
 * @returns {{ segment: string, cwd: string } | null}
 */
function bareSegment(command, ports) {
	const parsed = parseCommand(command);
	const { spans } = parsed;
	/** @param {string} w */
	const typed = (w) => typedWord(w, spans);
	/** @type {{ segment: string, cwd: string } | null} */
	let found = null;
	walkCommands(
		parsed,
		(cmd) => {
			if (found) return;
			const bare = cmd.runs().find(({ words }) => {
				const launch = suiteLaunchKind(words.map(typed), LAUNCH_PORTS);
				if (launch?.kind !== "npm-vitest") return false;
				return !words
					.slice(launch.taken)
					.some((w) => w !== "--" && literal(w, spans).text !== "--queue");
			});
			if (bare) found = { segment: cmd.segment, cwd: bare.dirs()[0] };
		},
		ports,
	);
	return found;
}

/**
 * @param {string} command
 * @param {UnaskedContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	const bare = bareSegment(command, ctx);
	if (!bare || !ctx.session) return null;
	const held = inFlightOf(ctx);
	if (held.length > 0)
		return { deny: require("./in-flight-runs.js").rerunRefusal(held) };
	const { root: tree } = ctx.tree();
	/** @type {Verdict} */
	let out;
	try {
		out = ctx.judge(
			{
				sessionId: ctx.session,
				cwd: bare.cwd,
				command: unmask(bare.segment),
			},
			tree,
		);
	} catch (e) {
		out = { why: `the judge threw: ${caught(e).message}` };
	}
	if (out.unread)
		ctx.log(
			"own work unreadable — the re-run judged on all of HEAD (workflow-core#1218)",
			out.unread,
		);
	if (out.why) {
		ctx.log(
			"could not judge whether certificates attest HEAD — a bare test run allowed unjudged",
			out.why,
		);
		return null;
	}
	if (!out.deny) return null;
	if (out.note)
		ctx.log(
			"a refusal went unrecorded — the post-change count (workflow-core#810) undercounts",
			out.note,
		);
	return { deny: `${out.deny}\n\n${unaskedRule(ctx)}` };
}

/**
 * @param {UnaskedContext} ctx
 * @returns {import("./in-flight-runs.js").InFlightRun[]}
 */
function inFlightOf(ctx) {
	let why;
	try {
		const runs = ctx.inFlight(ctx.session);
		if (runs) return require("./in-flight-runs.js").touchedRuns(runs);
		why = "the run records would not read";
	} catch (e) {
		why = `the in-flight reader threw: ${caught(e).message}`;
	}
	ctx.log(
		"could not read the session's in-flight test runs — a bare test run allowed without the in-flight check (workflow-core#5716)",
		why,
	);
	return [];
}

/** @param {UnaskedContext} ctx */
const unaskedRule = (ctx) =>
	ruleOrFallback(
		ctx,
		"unasked-rerun",
		"An unasked re-run is refused once a session",
	);

module.exports = { field: "command", noun: "command", decide };
