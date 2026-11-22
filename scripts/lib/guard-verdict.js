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

class Stop {
	/** @param {Decision} decision */
	constructor(decision) {
		this.decision = decision;
	}
}

/**
 * @param {Parsed} parsed
 * @param {(cmd: Command) => void} judge
 * @param {WalkPorts} ctx
 * @returns {Decision | undefined}
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
 * @param {string} segment
 * @param {string} text
 */
const spliceCmd = (segment, text) => text.split("@CMD@").join(unmask(segment));

/**
 * @param {PathPorts} ctx
 * @param {string} segment
 * @param {string} reason
 */
const denyText = (ctx, segment, reason) =>
	spliceCmd(segment, ctx.corePaths(reason));

/**
 * @param {PathPorts} ctx
 * @param {string} segment
 * @param {string} reason
 * @returns {never}
 */
function deny(ctx, segment, reason) {
	throw new Stop({ deny: denyText(ctx, segment, reason) });
}

/**
 * @param {{ log: (what: string) => void }} ctx
 * @param {string} what
 * @returns {never}
 */
function open(ctx, what) {
	ctx.log(what);
	throw new Stop(null);
}

/**
 * @param {RulePorts} ctx
 * @param {string} id
 * @param {string} lead
 * @param {() => void} [onFault]
 */
function ruleOrFallback(ctx, id, lead, onFault) {
	try {
		return ctx.ruleText(id);
	} catch {
		onFault?.();
		return `${lead}; the rule could not be read from ${ctx.docPath(`agents/rules/${id}.txt`)}. Restore that file from origin/main, or revert the change that removed it, then read it before doing anything else.`;
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
