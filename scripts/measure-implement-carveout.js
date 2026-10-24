#!/usr/bin/env node
/*
 * measure-implement-carveout.js — how many Opus /implement sessions committed
 * to repo machinery rather than product code, using the widened matcher in
 * scripts/lib/implement-carveout.js (mantahostels#2462).
 *
 * Usage:  node scripts/measure-implement-carveout.js [--since <iso>] [--until <iso>] [--dir <path>]
 *
 * REPORTS ONLY. Exit 0 on a reading; exit 2 where every corpus directory
 * refused to be read, or `--since`/`--until` will not parse (#1521).
 *
 * `--since` defaults to `DEFAULT_SINCE`, open-ended (corpus keeps growing).
 * Pair it with `--until` to close the window at a specific past population —
 * see mantahostels#2462 for the values that reproduce that ticket's own figures.
 */

const fs = require("node:fs");
const path = require("node:path");

const {
	isHardCarveOut,
	isAdjacent,
	scanSession,
} = require("./lib/implement-carveout.js");
const {
	listTranscripts,
	oneCopyEach,
	projectDirs,
} = require("./lib/project-dirs.js");
const { CliExit, exitWith, flagValue, parseOrExit } = require("./lib/cli-args");

const COMMAND = "implement";

/* mantahostels#2449's own re-run window start. */
const DEFAULT_SINCE = "2026-08-25T04:48:06Z";

const USAGE =
	"usage: node scripts/measure-implement-carveout.js [--since <iso>] [--until <iso>] [--dir <path>]";

/**
 * Ends the run where `Date.parse` cannot read a window bound: its `NaN`
 * compares false against every start, so the window would filter nothing
 * while the report still named it (#1521).
 *
 * @param {string} flag
 * @param {string} raw
 */
function refuseUnparseable(flag, raw) {
	if (!Number.isNaN(Date.parse(raw))) return;
	exitWith(
		new CliExit(
			2,
			`${flag} needs an ISO date or timestamp, not ${JSON.stringify(raw)}.\n\n${USAGE}\n`,
		),
	);
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
	const { flags } = parseOrExit(argv, {
		usage: USAGE,
		flags: { "--dir": "value", "--since": "value", "--until": "value" },
	});
	const since = flagValue(flags, "--since") ?? DEFAULT_SINCE;
	const until = flagValue(flags, "--until");
	refuseUnparseable("--since", since);
	if (until !== undefined) refuseUnparseable("--until", until);
	return {
		dir: flagValue(flags, "--dir"),
		since,
		until,
	};
}

/**
 * @typedef {object} Tally
 * @property {number} total
 * @property {number} opusCount
 * @property {number} hard
 * @property {number} adjacentOnly
 * @property {number} plainMiss
 * @property {number} unreadableFiles
 * @property {number} capped
 * @property {number} unparseableStart
 * @property {{ file: string, paths: string[] }[]} misses
 */

/**
 * @param {number} startedAt
 * @param {number} sinceMs
 * @param {number | null} untilMs
 * @returns {boolean}
 */
function isOutsideWindow(startedAt, sinceMs, untilMs) {
	if (startedAt < sinceMs) return true;
	return untilMs !== null && startedAt >= untilMs;
}

/**
 * Count one in-window /implement session against the tally: Opus only, then
 * hard carve-out, adjacent, or a plain miss, first match wins.
 *
 * @param {Tally} t accumulator: the session is counted, and a plain miss pushed
 * @param {string} file
 * @param {ReturnType<typeof scanSession>} s
 */
function classifySession(t, file, s) {
	t.total += 1;
	if (s.model !== "opus") return;
	t.opusCount += 1;
	const h = isHardCarveOut(s.paths);
	if (h.hit) {
		t.hard += 1;
		return;
	}
	const a = isAdjacent(s.paths);
	if (a.hit) {
		t.adjacentOnly += 1;
		return;
	}
	t.plainMiss += 1;
	t.misses.push({ file: path.basename(file), paths: s.paths });
}

/**
 * @param {string[]} files
 * @param {number} sinceMs
 * @param {number | null} untilMs
 * @returns {Tally}
 */
function tallySessions(files, sinceMs, untilMs) {
	/** @type {Tally} */
	const t = {
		total: 0,
		opusCount: 0,
		hard: 0,
		adjacentOnly: 0,
		plainMiss: 0,
		unreadableFiles: 0,
		capped: 0,
		unparseableStart: 0,
		misses: [],
	};
	for (const file of files) {
		let text;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {
			t.unreadableFiles += 1;
			continue;
		}
		const s = scanSession(text);
		if (s.capped) t.capped += 1;
		if (s.command !== COMMAND) continue;
		if (s.startedAt === null) {
			t.unparseableStart += 1;
			continue;
		}
		if (isOutsideWindow(s.startedAt, sinceMs, untilMs)) continue;
		classifySession(t, file, s);
	}
	return t;
}

/**
 * @param {{ dirs: string[], unreadableDirs: string[], opts: ReturnType<typeof parseArgs>, t: Tally }} report
 */
function printReport({ dirs, unreadableDirs, opts, t }) {
	console.log(`Corpus: ${dirs.join(", ")}`);
	if (unreadableDirs.length > 0)
		console.log(
			`  (${unreadableDirs.length} directory(ies) unreadable, excluded: ${unreadableDirs.join("; ")})`,
		);
	console.log(
		`Window: since ${opts.since}${opts.until ? ` until ${opts.until}` : ""}`,
	);
	console.log(`/implement sessions: ${t.total} (${t.opusCount} opus)`);
	console.log(`  hard carve-out (widened list): ${t.hard}`);
	console.log(`  adjacent only: ${t.adjacentOnly}`);
	console.log(`  plain miss: ${t.plainMiss}`);
	if (t.unreadableFiles)
		console.log(`  (${t.unreadableFiles} transcript(s) unreadable, excluded)`);
	if (t.capped)
		console.log(
			`  (${t.capped} transcript(s) capped before a <command-name> block turned up, so their command is unread)`,
		);
	if (t.unparseableStart)
		console.log(
			`  (${t.unparseableStart} /implement session(s) carry no parseable start timestamp, excluded from the window)`,
		);
	if (t.misses.length > 0) {
		console.log("\nPlain-miss sessions:");
		for (const r of t.misses)
			console.log(`  ${r.file}  paths=${JSON.stringify(r.paths.slice(0, 3))}`);
	}
}

function main() {
	const opts = parseArgs(process.argv.slice(2));
	const dirs = opts.dir ? [opts.dir] : projectDirs();

	const {
		found,
		unreadable: unreadableDirs,
		absent: absentDirs,
	} = listTranscripts(dirs);

	if (unreadableDirs.length + absentDirs.length === dirs.length) {
		console.error(
			`Cannot read any corpus directory (${[...unreadableDirs, ...absentDirs.map((d) => `${d} (absent)`)].join("; ")}). ` +
				"This is a broken read, NOT a low miss count.",
		);
		process.exit(2);
	}

	const files = oneCopyEach(found);

	const sinceMs = Date.parse(opts.since);
	const untilMs = opts.until ? Date.parse(opts.until) : null;
	const t = tallySessions(files, sinceMs, untilMs);

	printReport({ dirs, unreadableDirs, opts, t });
}

main();
