#!/usr/bin/env node
const fs = require("node:fs");
const { closingMatch, closingRefusal } = require("./lib/closing-keyword.js");
const { recordedLines } = require("./lib/commit-message.js");
const { runCheck } = require("./lib/check.js");

/** @typedef {import("./lib/check").Ctx} Ctx */

/**
 * @param {string} raw
 */
function messageText(raw) {
	return recordedLines(raw)
		.filter((line) => !line.startsWith('Revert "'))
		.join("\n");
}

/** @param {Ctx} ctx */
function run(ctx) {
	if (ctx.args.length > 2) ctx.usageError("at most two arguments.");
	const [file = "", context = "commit"] = ctx.args;
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		ctx.broken(
			`${context}: cannot read the commit message file ('${file}').\n  Refusing rather than passing a message nothing has read (#138).`,
		);
	}
	const match = closingMatch(messageText(raw));
	if (match === null) return { okLine: "no closing keyword in the message." };
	ctx.fail("closing-keyword", `the message closes an issue: ${match}`);
	ctx.say(
		`${context}: this commit message closes an issue server-side the moment it is pushed.\n\n${closingRefusal(match)}`,
	);
	return { noun: "closing keyword(s)" };
}

const SPEC = {
	name: "commit-message-closes",
	usage: "node check-commit-message-closes.js <message-file> [<context>]",
	run,
};

module.exports = { SPEC };

if (require.main === module) runCheck(SPEC);
