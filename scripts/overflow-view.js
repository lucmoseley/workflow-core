#!/usr/bin/env node
/*
 * overflow-view.js — the founder's view of the overflow seats' headless
 * sessions (#3685, #4583), laid out as `claude agents` lays out plan sessions
 * (lib/overflow-viewer.js): awaiting input, working, completed.
 *
 * A headless session cannot wait for input: one that asks the founder
 * something ends on a `needs input:` line. A reply resumes the session with
 * it as the next turn, on the same overflow seat and key, through
 * lib/headless-sessions.js, which hands the key to the child through the
 * `apiKeyHelper` alone. A stop goes through lib/claude-stop.js, as the refill
 * loop's does.
 *
 * Usage:
 *   node scripts/overflow-view.js     on a terminal, the view; piped, its list once
 *
 * Keys: ↑↓ select · Enter open the thread · Space reply · ← back · x stop · q quit
 */

const fs = require("node:fs");
const { parseArgs } = require("node:util");
const { caught } = require("./lib/caught.js");
const { stopOn } = require("./lib/claude-stop.js");
const { launch } = require("./lib/headless-sessions.js");
const { hostRoot } = require("./lib/host-root.js");
const { seatBudget } = require("./lib/overflow-budget.js");
const {
	buildListLines,
	openViewer,
	readSessions,
} = require("./lib/overflow-viewer.js");
const {
	findOverflowSeat,
	readDeclaredSeats,
} = require("./lib/refill-seats.js");
const { writeFd } = require("./lib/write-fd.js");

/** @typedef {import("./lib/headless-runs.js").RunRecord} RunRecord */

/* A reply's spend ceiling, as `--max-budget-usd`. Untraced. */
const REPLY_BUDGET_USD = 15;

/**
 * The key's headroom for one more run, gated as the dispatcher gates a launch
 * (scripts/dispatch-sessions.sh): nothing past it.
 * @param {string} keyVar
 * @returns {{usd: number}|{why: string}}
 */
function readHeadroom(keyVar) {
	const seat = findOverflowSeat(readDeclaredSeats(), keyVar);
	if (!seat)
		return { why: `${keyVar} is not an overflow seat's key in the seat file` };
	const budget = seatBudget(seat, hostRoot());
	if ("why" in budget) return budget;
	if (budget.exhausted || budget.fit === 0)
		return { why: "the key's budget does not fit a reply" };
	return { usd: budget.headroomUsd };
}

/**
 * Resume `run`'s session headless with `text` as its next turn.
 * @param {RunRecord} run
 * @param {string} text
 * @param {(keyVar: string) => {usd: number}|{why: string}} [headroomOf]
 * @returns {{jobId: string}|{why: string}}
 */
function sendReply(run, text, headroomOf = readHeadroom) {
	const headroom = headroomOf(run.keyVar);
	if ("why" in headroom) return headroom;
	const out = launch({
		keyVar: run.keyVar,
		cwd: run.cwd,
		budgetUsd: Math.min(REPLY_BUDGET_USD, headroom.usd),
		prompt: text,
		resume: run.sessionId,
	});
	return "why" in out ? out : { jobId: out.record.jobId };
}

/**
 * @param {RunRecord} run
 * @returns {{ok: true, said: string}|{ok: false, why: string}}
 */
const stopRun = (run) => stopOn(run.seat, run.jobId);

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
		const { lines } = buildListLines(readSessions(), null, 200, false);
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

module.exports = { main, sendReply };

if (require.main === module) {
	try {
		const code = main(process.argv.slice(2));
		if (code !== null) process.exitCode = code;
	} catch (err) {
		writeFd(2, `overflow sessions unreadable: ${caught(err).message}\n`);
		process.exitCode = 1;
	}
}
