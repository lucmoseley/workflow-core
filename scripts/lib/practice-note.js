const { runOnTrigger } = require("./shell-guard.js");

const TRIGGER = /docs\/practice/;

/**
 * @param {string} _subject
 * @param {import("./shell-guard.js").ShellGuardContext} ctx
 */
function decide(_subject, ctx) {
	const { path = "", pattern = "" } = ctx.input;
	const subject = `${JSON.stringify(ctx.input)}\n${path}/${pattern}`;
	return runOnTrigger("practice-guard.sh", TRIGGER, subject, ctx);
}

module.exports = {
	field: ["file_path", "command", "path", "pattern"],
	noun: "call",
	decide,
};
