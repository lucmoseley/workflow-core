#!/usr/bin/env node

const { parseArgs } = require("node:util");
const { caught } = require("./lib/caught.js");
const { sendReply, stopRun } = require("./lib/overflow-actions.js");
const {
	buildListLines,
	openViewer,
	readSessions,
} = require("./lib/overflow-viewer.js");
const { writeFd } = require("./lib/write-fd.js");

const { scriptPath } = require("./lib/script-path.js");
const PIPE_COLUMNS = Number.POSITIVE_INFINITY;

const HELP_TEXT = `overflow-view.js — the overflow seats' headless sessions, laid out as
\`claude agents\` lays out plan sessions: awaiting input, working, completed.

Usage:
  node ${scriptPath("overflow-view.js")}     on a terminal, the view; piped, its list once

Keys: ↑↓ select · Enter open the thread · Space reply · ← back · x stop · q quit`;

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
		writeFd(1, `${HELP_TEXT}\n`);
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
