#!/usr/bin/env node
/*
 * watch-artefact.js — one backgrounded call that watches a subagent's artefact
 * and exits exactly when the abandon rule says to act (workflow-core#539, spec workflow-core#535): two
 * consecutive checks with no growth. Its exit is the background-job
 * notification that wakes the parent, in place of a re-issued timed
 * `sleep <n>; wc -c <artefact>`.
 *
 * Usage:
 *   node scripts/watch-artefact.js <path> <interval-seconds> [ceiling-seconds]
 *
 * The interval and ceiling accept fractions. The first check is the baseline;
 * each later one compares the size with the check before it. Prints one start
 * line to stderr, then exactly one verdict line to stdout, and exits on it:
 *
 *   STALLED  3  two consecutive checks saw no change, the file present at
 *               one of them at least
 *   MISSING  4  the file was absent at two consecutive checks — never written,
 *               or deleted
 *   CEILING  5  the ceiling came before a stall
 *   (bad invocation, or a path that cannot be stat'd: 2, on stderr; a crash: 1)
 *
 * Last growth on the verdict line is the check that saw it, not the write
 * itself.
 *
 * SIZE, NOT MTIME: a touch without an append is not progress. A size that
 * FALLS counts as progress — a rewrite is the agent working, not stalled.
 *
 * THE DEFAULT CEILING, 60 MINUTES, IS A GUESS: room above the ~18-minute
 * median wait in https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/waiting-stall-forensics.md §5, never measured
 * against a watch. It bounds the loop, which lives inside this script where
 * neither guard-wait-loop.sh nor check-orphan-wait-loops.js sees it.
 *
 * A check lands on each whole interval from the start, so a slow wake does not
 * drift the ones after it. The ceiling is not a check: a shortened last
 * interval would compare unequal windows, so reaching it reports CEILING
 * unjudged.
 *
 * IT CANNOT TELL A STALLED AGENT FROM A FINISHED ONE — no file shows that.
 *
 * Joins no §N3 family: it is a tool an agent runs, not a check, guard,
 * generator or reporter, and its exit codes are its verdicts.
 */

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const { caught } = require("./lib/caught.js");
const { parseOrExit } = require("./lib/cli-args.js");

const DEFAULT_CEILING_S = 3600;

const EXIT = { USAGE: 2, STALLED: 3, MISSING: 4, CEILING: 5 };

const ADVICE = {
	STALLED:
		"no growth across two checks; abandon the agent unless it has already reported",
	MISSING:
		"absent at two consecutive checks; never written, deleted, or the wrong path",
	CEILING:
		"the ceiling came before two checks without growth; re-run the watch to keep waiting",
};

// This file's own path, which in an adopter is the plugin's, not `scripts/`.
const USAGE = `usage: node ${__filename} <path> <interval-seconds> [ceiling-seconds]`;

/**
 * @param {string} message
 * @returns {never}
 */
function refuse(message) {
	writeFd(2, `watch-artefact: ${message}\n${USAGE}\n`);
	process.exit(EXIT.USAGE);
}

/**
 * @param {string | undefined} raw
 * @param {string} name
 * @returns {number} seconds, positive and finite
 */
function parseSeconds(raw, name) {
	const n = Number(raw);
	if (raw === undefined || raw.trim() === "" || !Number.isFinite(n) || n <= 0)
		refuse(`${name} must be a positive number of seconds, got ${raw}`);
	return n;
}

/**
 * @param {string} file
 * @returns {number | null} the size in bytes, or null where the file is absent
 */
function sizeOf(file) {
	let stat;
	try {
		stat = fs.statSync(file);
	} catch (e) {
		const { code, message } = caught(e);
		if (code === "ENOENT" || code === "ENOTDIR") return null;
		refuse(`cannot stat ${file}: ${code ?? message}`);
	}
	if (!stat.isFile()) refuse(`${file} is not a regular file`);
	return stat.size;
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
	const [file, rawInterval, rawCeiling] = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		max: 3,
	}).positionals;
	if (!file) refuse("no artefact path");
	const intervalMs = parseSeconds(rawInterval, "interval") * 1000;
	const ceilingMs =
		(rawCeiling === undefined
			? DEFAULT_CEILING_S
			: parseSeconds(rawCeiling, "ceiling")) * 1000;

	const start = Date.now();
	let size = sizeOf(file);
	/** @type {number | null} */
	let lastGrowth = null;
	let idle = 0;
	let absent = 0;
	writeFd(
		2,
		`watch-artefact: watching ${file} every ${intervalMs / 1000}s, ceiling ${ceilingMs / 1000}s\n`,
	);

	/** @param {keyof typeof ADVICE} verdict */
	const finish = (verdict) => {
		const at =
			lastGrowth === null ? "none" : new Date(lastGrowth).toISOString();
		writeFd(
			1,
			`${verdict} ${file} size=${size ?? "absent"} last-growth=${at} — ${ADVICE[verdict]}\n`,
		);
		process.exit(EXIT[verdict]);
	};

	for (let check = 1; ; check++) {
		const due = start + check * intervalMs;
		if (due > start + ceilingMs) {
			await sleep(start + ceilingMs - Date.now());
			finish("CEILING");
		}
		await sleep(due - Date.now());
		const now = sizeOf(file);
		if (now !== null && now !== size) {
			idle = 0;
			lastGrowth = Date.now();
		} else {
			idle++;
		}
		absent = now === null ? absent + 1 : 0;
		size = now;
		if (idle >= 2) finish(absent >= 2 ? "MISSING" : "STALLED");
	}
}

// Exit 1, a code no verdict uses, so a crash never reads as one.
main().catch((/** @type {any} */ err) => {
	writeFd(2, `watch-artefact: ${err?.stack ?? err}\n`);
	process.exit(1);
});
