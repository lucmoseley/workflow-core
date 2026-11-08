#!/usr/bin/env node
/*
 * watch-artefact.js — one backgrounded call that watches a subagent's artefact
 * and exits exactly when the abandon rule says to act (#539, spec #535): two
 * consecutive checks with no growth. Its exit is the background-job
 * notification that wakes the parent.
 *
 * Usage:
 *   node scripts/watch-artefact.js <path> <interval-seconds> [ceiling-seconds]
 *     [--first-write <seconds>]
 *
 * The interval, ceiling and first-write deadline accept fractions. The first check is the baseline;
 * each later one compares the size with the check before it. Prints one start
 * line to stderr, then exactly one verdict line to stdout, and exits on it:
 *
 *   STALLED  3  two consecutive checks saw no change, the file present at
 *               one of them at least
 *   MISSING  4  never present by the first check at or past the first-write
 *               deadline, or absent at two consecutive checks once seen
 *   CEILING  5  the ceiling came before a stall
 *   (bad invocation, or a path that cannot be stat'd: 2, on stderr; a crash: 1)
 *
 * Last growth on the verdict line is the check that saw it, not the write
 * itself.
 *
 * THE FIRST-WRITE DEADLINE, 600 S BY DEFAULT, IS MEASURED (#4034, its figures
 * there). Until the file is first seen, no check counts toward any verdict. A
 * deadline under two intervals is raised to two, so a never-seen file is
 * absent at two checks at least. Residual: about 0.5% of live agents first
 * write after 600 s and still draw MISSING; a wrong path, or an agent that
 * never starts, reads MISSING only at the deadline.
 *
 * SIZE, NOT MTIME: a touch without an append is not progress. A size that
 * FALLS counts as progress — a rewrite is the agent working, not stalled.
 *
 * THE DEFAULT CEILING, 60 MINUTES, IS A GUESS: room above the ~18-minute
 * median wait in https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/waiting-stall-forensics.md §5, never measured
 * against a watch. It bounds the loop, which lives inside this script where
 * neither lib/wait-loop.js nor check-orphan-wait-loops.js sees it.
 *
 * A check lands on each whole interval from the start, so a slow wake does not
 * drift the ones after it. The ceiling is not a check: a shortened last
 * interval would compare unequal windows, so reaching it reports CEILING
 * unjudged.
 *
 * IT CANNOT TELL A STALLED AGENT FROM A FINISHED ONE.
 *
 * Joins no §N3 family: it is a tool an agent runs, not a check, guard,
 * generator or reporter, and its exit codes are its verdicts.
 */

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const { caught } = require("./lib/caught.js");
const { parseOrExit } = require("./lib/cli-args.js");

const DEFAULT_CEILING_S = 3600;
const DEFAULT_FIRST_WRITE_S = 600;

const EXIT = { USAGE: 2, STALLED: 3, MISSING: 4, CEILING: 5 };

const ADVICE = {
	STALLED:
		"no growth across two checks; abandon the agent unless it has already reported",
	MISSING:
		"never written by the first-write deadline, deleted, or the wrong path",
	CEILING:
		"the ceiling came before two checks without growth; re-run the watch to keep waiting",
};

// This file's own path, which in an adopter is the plugin's, not `scripts/`.
const USAGE = `usage: node ${__filename} <path> <interval-seconds> [ceiling-seconds] [--first-write <seconds>]`;

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
function readSizeOf(file) {
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

/** The verdict state over successive checks of one file's size. */
class SizeTrack {
	/**
	 * @param {number | null} baseline the size at the start, null where absent
	 * @param {number} firstWriteMs how long a never-seen file is waited on
	 */
	constructor(baseline, firstWriteMs) {
		this.size = baseline;
		/** @type {number | null} */
		this.lastGrowth = null;
		this.firstWriteMs = firstWriteMs;
		this.seen = baseline !== null;
		this.idle = 0;
		this.absent = 0;
	}

	/**
	 * @param {number | null} now the size at this check
	 * @param {number} elapsedMs since the start
	 * @returns {"MISSING" | "STALLED" | null}
	 */
	observe(now, elapsedMs) {
		if (!this.seen && now === null)
			return elapsedMs >= this.firstWriteMs ? "MISSING" : null;
		this.seen = true;
		const grew = now !== null && now !== this.size;
		this.idle = grew ? 0 : this.idle + 1;
		if (grew) this.lastGrowth = Date.now();
		this.absent = now === null ? this.absent + 1 : 0;
		this.size = now;
		if (this.idle < 2) return null;
		return this.absent >= 2 ? "MISSING" : "STALLED";
	}
}

/**
 * @param {string | true | undefined} raw
 * @param {string} name
 * @param {number} fallback seconds, where the argument is not given
 * @returns {number} milliseconds
 */
const parseOptionalMs = (raw, name, fallback) =>
	(raw === undefined ? fallback : parseSeconds(String(raw), name)) * 1000;

function readArgs() {
	const { positionals, flags } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		max: 3,
		flags: { "--first-write": "value" },
	});
	const [file, rawInterval, rawCeiling] = positionals;
	if (!file) refuse("no artefact path");
	const intervalMs = parseSeconds(rawInterval, "interval") * 1000;
	return {
		file,
		intervalMs,
		ceilingMs: parseOptionalMs(rawCeiling, "ceiling", DEFAULT_CEILING_S),
		firstWriteMs: Math.max(
			parseOptionalMs(
				flags["--first-write"],
				"first-write",
				DEFAULT_FIRST_WRITE_S,
			),
			2 * intervalMs,
		),
	};
}

async function main() {
	const { file, intervalMs, ceilingMs, firstWriteMs } = readArgs();

	const start = Date.now();
	const tracker = new SizeTrack(readSizeOf(file), firstWriteMs);
	writeFd(
		2,
		`watch-artefact: watching ${file} every ${intervalMs / 1000}s, first write by ${firstWriteMs / 1000}s, ceiling ${ceilingMs / 1000}s\n`,
	);

	/** @param {keyof typeof ADVICE} verdict */
	const finish = (verdict) => {
		const { size, lastGrowth } = tracker;
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
		const verdict = tracker.observe(readSizeOf(file), check * intervalMs);
		if (verdict) finish(verdict);
	}
}

module.exports = { main };

// Exit 1, a code no verdict uses, so a crash never reads as one.
if (require.main === module)
	main().catch((/** @type {any} */ err) => {
		writeFd(2, `watch-artefact: ${err?.stack ?? err}\n`);
		process.exit(1);
	});
