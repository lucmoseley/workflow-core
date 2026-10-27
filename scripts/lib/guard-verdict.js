/*
 * guard-verdict.js — the verdict walk a Node guard core is built from (#2885):
 * the first verdict a judge throws ends the walk, a refusal splices the
 * segment into its `@CMD@`, and a rule the store cannot give is answered by
 * its fallback (base §S4).
 *
 * A rule's id stays a literal at the core's own ruleOrFallback call:
 * check-guard-registry.js counts a fragment as printed only there (#2796).
 */

const { unmask, walkCommands } = require("./shell-parse.js");

/**
 * @typedef {import("./guard-entry.js").Decision} Decision
 * @typedef {import("./shell-parse.js").Command} Command
 * @typedef {import("./shell-parse.js").Parsed} Parsed
 * @typedef {import("./shell-parse.js").WalkPorts} WalkPorts
 * @typedef {{ corePaths: (text: string) => string }} PathPorts
 * @typedef {{
 *   ruleText: (id: string) => string,
 *   docPath: (name: string) => string,
 * }} RulePorts
 */

/** The one verdict that ends the walk: a decision, or null for a fail-open. */
class Stop {
	/** @param {Decision} decision */
	constructor(decision) {
		this.decision = decision;
	}
}

/**
 * Walk every command `parsed` runs through `judge` until one throws a Stop.
 * @param {Parsed} parsed
 * @param {(cmd: Command) => void} judge
 * @param {WalkPorts} ctx
 * @returns {Decision | undefined} the Stop's decision, undefined where the
 *   walk ran to its end
 */
function walkVerdict(parsed, judge, ctx) {
	/** @type {Decision | undefined} */
	let stopped;
	try {
		walkCommands(parsed, judge, ctx);
	} catch (e) {
		if (!(e instanceof Stop)) throw e;
		stopped = e.decision;
	}
	return stopped;
}

/**
 * The segment, as a human reads it, in place of each `@CMD@` in `text`.
 * @param {string} segment masked
 * @param {string} text
 */
const spliceCmd = (segment, text) => text.split("@CMD@").join(unmask(segment));

/**
 * A refusal's text: core paths spelt as an install reaches them, then the
 * segment spliced in — after the paths, so the command is shown as typed.
 * @param {PathPorts} ctx
 * @param {string} segment masked
 * @param {string} reason
 */
const denyText = (ctx, segment, reason) =>
	spliceCmd(segment, ctx.corePaths(reason));

/**
 * @param {PathPorts} ctx
 * @param {string} segment masked
 * @param {string} reason
 * @returns {never}
 */
function deny(ctx, segment, reason) {
	throw new Stop({ deny: denyText(ctx, segment, reason) });
}

/**
 * Record a fail-open and let the whole call through unjudged.
 * @param {{ log: (what: string) => void }} ctx
 * @param {string} what
 * @returns {never}
 */
function open(ctx, what) {
	ctx.log(what);
	throw new Stop(null);
}

/**
 * The fragment `id`, or where the store cannot give it the fallback template
 * (#3018) built from `lead` and the same id, so the two cannot name different
 * fragments. Not a fail-open: the command is resolved and known bad, only the
 * rule could not be read, so it still refuses (mantahostels#1648, #2801);
 * `onFault` is told where a guard logs it.
 * @param {RulePorts} ctx
 * @param {string} id
 * @param {string} lead the fallback's opening, no closing stop
 * @param {() => void} [onFault]
 */
function ruleOrFallback(ctx, id, lead, onFault) {
	try {
		return ctx.ruleText(id);
	} catch {
		onFault?.();
		return `${lead}; the rule could not be read from ${ctx.docPath(`agents/rules/${id}.txt`)}. Read that file before doing anything else.`;
	}
}

module.exports = {
	deny,
	denyText,
	open,
	ruleOrFallback,
	spliceCmd,
	walkVerdict,
};
