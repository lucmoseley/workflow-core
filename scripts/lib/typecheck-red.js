/**
 * @typedef {{ at: string, command: string, output: string, cut: boolean }} RedTry
 * @typedef {(sid: string) => RedTry | null} TakeRed
 */

/**
 * @param {RedTry} red
 * @returns {string}
 */
function redReport({ at, command, output, cut }) {
	return `Your commit's pre-commit type-check ran RED at ${at}, which this gate reports and does not block on: \`${command}\` said
${output}${cut ? "\n… cut here; the command prints the rest." : ""}
An error may be a file saved while it ran. Re-run \`${command}\` on a still tree before believing it, and fix any error your work caused: ci.yml's Typecheck step is the gate.`;
}

/**
 * @param {string} _command
 * @param {import("./core-contract.js").CoreContext & { takeRed: TakeRed }} ctx
 */
function decide(_command, ctx) {
	if (!ctx.session || ctx.agent) return null;
	const red = ctx.takeRed(ctx.session);
	return red ? { context: redReport(red) } : null;
}

module.exports = {
	field: "command",
	noun: "type-check report",
	decide,
	redReport,
};
