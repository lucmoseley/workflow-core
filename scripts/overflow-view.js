#!/usr/bin/env node
/*
 * overflow-view.js — the founder's view of the overflow seats' headless
 * sessions (#3685, #4583), laid out as `claude agents` lays out plan sessions
 * (lib/overflow-viewer.js): awaiting input, working, completed.
 *
 * A headless session cannot wait for input: one that asks the founder
 * something ends on a `needs input:` line. A reply resumes the session with
 * it as the next turn, on the same overflow seat and key; a stop goes
 * through the refill loop's stop routing (lib/overflow-actions.js).
 *
 * Usage:
 *   node scripts/overflow-view.js     on a terminal, the view; piped, its list once
 *
 * Keys: ↑↓ select · Enter open the thread · Space reply · ← back · x stop · q quit
 */

const fs = require("node:fs");
const { parseArgs } = require("node:util");
const { caught } = require("./lib/caught.js");
const { sendReply, stopRun } = require("./lib/overflow-actions.js");
const {
	buildListLines,
	openViewer,
	readSessions,
} = require("./lib/overflow-viewer.js");
const { writeFd } = require("./lib/write-fd.js");

const PIPE_COLUMNS = Number.POSITIVE_INFINITY;

/** @param {string[]} argv */
function main(argv) {
	let parsed;
	try {
		parsed = parseArgs({ args: argv, options: { help: { type: "boolean" } } });
	} catch (err) {
		writeFd(2, `${caught(err).message}\n`);
		return 2;
	}
	if (parsed.values.help) {
		const text = fs.readFileSync(__filename, "utf8");
		writeFd(1, `${text.slice(0, text.indexOf("*/"))}\n`);
		return 0;
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		const { lines } = buildListLines(readSessions(), null, PIPE_COLUMNS, false);
		writeFd(1, `${lines.join("\n")}\n`);
		return 0;
	}
	openViewer({
		stdin: process.stdin,
		stdout: process.stdout,
		proc: process,
		reply: sendReply,
		stop: stopRun,
		reportCrash: (err) =>
			writeFd(2, `${err instanceof Error ? err.stack : err}\n`),
	});
	return null;
}

module.exports = { main };

if (require.main === module) {
	try {
		const code = main(process.argv.slice(2));
		if (code !== null) process.exitCode = code;
	} catch (err) {
		writeFd(2, `overflow sessions unreadable: ${caught(err).message}\n`);
		process.exitCode = 1;
	}
}
