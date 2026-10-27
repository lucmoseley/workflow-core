/*
 * guard-verdict.js — the verdict walk a Node guard core is built from (#2885):
 * the first verdict a judge throws ends the walk, a refusal splices the
 * segment into its `@CMD@`, and a rule the store cannot give is answered by
 * its fallback (base §S4).
 *
 * The rule read stays a thunk at the core's call site, its id a literal:
 * check-guard-registry.js counts a fragment as printed only there (#2796).
 */

const { unmask, walkCommands } = require("./shell-parse.js");

/**
 * @typedef {import("./guard-entry.js").Decision} Decision
 * @typedef {import("./shell-parse.js").Command} Command
 * @typedef {import("./shell-parse.js").Parsed} Parsed
 * @typedef {import("./shell-parse.js").WalkPorts} WalkPorts
 * @typedef {{ corePaths: (text: string) => string }} PathPorts
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
 * The fragment, or `fallback` where the store cannot give it. Not a
 * fail-open: the command is resolved and known bad, only the rule could not
 * be read, so it still refuses (mantahostels#1648, #2801); `onFault` is told
 * where a guard logs it.
 * @param {() => string} read
 * @param {string} fallback
 * @param {() => void} [onFault]
 */
function ruleOr(read, fallback, onFault) {
	try {
		return read();
	} catch {
		onFault?.();
		return fallback;
	}
}

module.exports = { deny, denyText, open, ruleOr, spliceCmd, walkVerdict };
