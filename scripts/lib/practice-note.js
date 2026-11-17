/*
 * practice-note.js — the dispatcher core that runs scripts/practice-guard.sh
 * on a Read, Glob, Write or Bash call whose input names docs/practice
 * (#5384, #5389). TRIGGER admits every call the script acts on and more; the
 * script makes the exact cut.
 */

const { runOnTrigger } = require("./shell-guard.js");

const TRIGGER = /docs\/practice/;

/**
 * @param {string} _subject
 * @param {import("./shell-guard.js").ShellGuardContext} ctx
 */
function decide(_subject, ctx) {
	const { path = "", pattern = "" } = ctx.input;
	/* The script joins a Glob's path and pattern, so `docs` and `practice/*` meet only there. */
	const subject = `${JSON.stringify(ctx.input)}\n${path}/${pattern}`;
	return runOnTrigger("practice-guard.sh", TRIGGER, subject, ctx);
}

module.exports = {
	field: ["file_path", "command", "path", "pattern"],
	noun: "call",
	decide,
	TRIGGER,
};
