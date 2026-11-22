/**
 * @param {string} _command
 * @param {Pick<import("./core-contract.js").CoreContext, "input">} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(_command, ctx) {
	if (ctx.input.run_in_background !== true) return null;
	return { injectRules: ["killed-background-job"] };
}

module.exports = { field: "command", noun: "background job", decide };
