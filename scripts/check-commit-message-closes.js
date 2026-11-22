#!/usr/bin/env node
const fs = require("node:fs");
const { closingMatch, closingRefusal } = require("./lib/closing-keyword.js");
const { recordedLines } = require("./lib/commit-message.js");
const { parseOrExit } = require("./lib/cli-args.js");

const CLI = {
	usage:
		"usage: node check-commit-message-closes.js <message-file> [<context>]",
	max: 2,
};

/**
 * @param {string} raw
 */
function messageText(raw) {
	return recordedLines(raw)
		.filter((line) => !line.startsWith('Revert "'))
		.join("\n");
}

/**
 * @param {string[]} argv
 * @returns {{ code: 0 | 1, stderr: string }}
 */
function main(argv) {
	const [file = "", context = "commit"] = argv;
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return {
			code: 1,
			stderr: `${context}: cannot read the commit message file ('${file}').\n  Refusing rather than passing a message nothing has read (#138).\n`,
		};
	}
	const match = closingMatch(messageText(raw));
	if (match === null) return { code: 0, stderr: "" };
	return {
		code: 1,
		stderr: `${context}: this commit message closes an issue server-side the moment it is pushed.\n\n${closingRefusal(match)}\n`,
	};
}

if (require.main === module) {
	const { positionals } = parseOrExit(process.argv.slice(2), CLI);
	const { code, stderr } = main(positionals);
	if (stderr) process.stderr.write(stderr);
	process.exitCode = code;
}

module.exports = { main };
