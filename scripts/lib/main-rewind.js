const { ruleOrFallback } = require("./guard-verdict.js");

/**
 * @param {import("./guard-verdict.js").RulePorts} ctx
 * @param {string} what
 */
const rewindReason = (ctx, what) =>
	`This ${what}: @CMD@\n\n${ruleOrFallback(ctx, "main-rewind", "Never move `main` backwards")}`;

/**
 * @param {import("./guard-verdict.js").RulePorts} ctx
 */
const remoteRewindRule = (ctx) =>
	ruleOrFallback(
		ctx,
		"main-remote-rewind",
		"Only the queue lander moves `main`, and never backwards",
	);

module.exports = { remoteRewindRule, rewindReason };
