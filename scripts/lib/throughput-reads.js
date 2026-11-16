/*
 * throughput-reads.js — the reads the throughput breaker, the gate-run budget
 * (lib/refill-breaker.js, lib/refill-budget.js) and the morning review's
 * Throughput section share (#5275).
 */

const path = require("node:path");
const { readCommitsBy } = require("./arbiter-ledger.js");
const { readText } = require("./file-read.js");
const { gateRunLogPath } = require("./gate-seat.js");
const { gitOrNull } = require("./git.js");
const { jobDirPath } = require("./job-paths.js");
const { parseJsonl } = require("./jsonl.js");
const {
	breakerRecordPath,
	foldBreakerAt,
	sessionIdsOf,
	workingMsOf,
} = require("./refill-breaker.js");

/** A guess: long enough for a fetched repo's log over the lookback, short of a stall. */
const GIT_LOG_TIMEOUT_MS = 20_000;

/**
 * @typedef {import("./refill-breaker.js").BreakerLaunch & {seat: string}} SeatedLaunch
 * @typedef {import("./refill-breaker.js").BreakerEvent} BreakerEvent
 * @typedef {import("./gate-seat.js").GateRun} GateRun
 * @typedef {{checkout: string, commits: number|null, workingHours: number,
 *   gateRuns: number|null, state: import("./refill-breaker.js").BreakerState|null,
 *   events: BreakerEvent[]|null}} RepoThroughput a served checkout's window for
 *   the morning review: its commits on `origin/main`, its loop sessions'
 *   working hours, its gate runs, its breaker's state at the window's end and
 *   the record's events in the window
 */

/**
 * `root`'s non-merge commits on `origin/main` committed after `since`, with
 * their commit times; null where git will not answer.
 * @param {string} root
 * @param {number} since ms
 * @returns {{sha: string, at: number}[]|null}
 */
function readMainCommits(root, since) {
	const out = gitOrNull(
		[
			"-C",
			root,
			"log",
			"origin/main",
			"--no-merges",
			`--since=@${Math.floor(since / 1000)}`,
			"--format=%H %ct",
		],
		{ timeout: GIT_LOG_TIMEOUT_MS },
	);
	if (out === null) return null;
	return out
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [sha = "", ct = "0"] = line.split(" ");
			return { sha, at: Number(ct) * 1000 };
		});
}

/**
 * A JSONL file's rows: [] where it does not exist, null where it will not read.
 * @param {string|null} file
 * @returns {Record<string, unknown>[]|null}
 */
function readRows(file) {
	if (file === null) return null;
	const read = readText(file);
	if (read.state === "absent") return [];
	return read.state === "read" ? parseJsonl(read.data).rows : null;
}

/**
 * `root`'s gate-run record; null where it will not read.
 * @param {string} root
 * @returns {GateRun[]|null}
 */
const readGateRuns = (root) =>
	/** @type {GateRun[]|null} */ (readRows(gateRunLogPath(root)));

/**
 * The breaker's record, oldest first; null where it will not read.
 * @returns {BreakerEvent[]|null}
 */
const readBreakerRecord = () =>
	/** @type {BreakerEvent[]|null} */ (readRows(breakerRecordPath()));

/**
 * `l`'s job timeline, its last row counted to its finish or `now`; null where
 * its file will not read.
 * @param {SeatedLaunch} l
 * @param {number} now
 * @returns {import("./refill-breaker.js").SessionTimeline|null}
 */
function readSessionTimeline(l, now) {
	if (l.jobId === null) return null;
	const rows = readRows(
		path.join(jobDirPath(l.seat, l.jobId), "timeline.jsonl"),
	);
	if (rows === null) return null;
	return {
		rows: rows.flatMap((r) =>
			typeof r.at === "string" && typeof r.state === "string"
				? [{ at: r.at, state: r.state }]
				: [],
		),
		endAt: l.finishedAt ?? now,
	};
}

/**
 * The shas `l`'s sessions committed in its checkout, an unread ledger as none.
 * @param {import("./refill-breaker.js").BreakerLaunch} l
 */
const readCommitsOf = (l) =>
	[...sessionIdsOf(l)].flatMap((id) => readCommitsBy(id, l.root) ?? []);

/**
 * A tick's ThroughputRead for `roots`, each checkout's commits read back to
 * `lookbackOf(root)`.
 * @param {string[]} roots
 * @param {(root: string) => number} lookbackOf
 * @param {number} now
 * @returns {import("./refill-breaker.js").ThroughputRead}
 */
function readThroughput(roots, lookbackOf, now) {
	return {
		byRoot: Object.fromEntries(
			roots.map((root) => [
				root,
				{
					commits: readMainCommits(root, lookbackOf(root)),
					gateRuns: readGateRuns(root),
				},
			]),
		),
		timelineOf: (l) =>
			readSessionTimeline(/** @type {SeatedLaunch} */ (l), now),
		commitsOf: readCommitsOf,
		record: readBreakerRecord(),
	};
}

/**
 * Each served checkout's throughput over [lo, hi] for the morning review
 * (#5275). A loop session counts where it ran in the window; one whose
 * timeline will not read counts no hours.
 * @param {{roots: string[], launches: SeatedLaunch[], lo: number, hi: number}} window
 * @returns {RepoThroughput[]}
 */
function readThroughputWindow({ roots, launches, lo, hi }) {
	const record = readBreakerRecord();
	/** @param {string} at */
	const inWindow = (at) => Date.parse(at) > lo && Date.parse(at) <= hi;
	return roots.map((root) => {
		const commits = readMainCommits(root, lo);
		const gateRuns = readGateRuns(root);
		const sessions = launches
			.filter(
				(l) =>
					l.root === root && l.launchedAt < hi && (l.finishedAt ?? hi) > lo,
			)
			.flatMap((l) => readSessionTimeline(l, hi) ?? []);
		return {
			checkout: path.basename(root),
			commits:
				commits === null ? null : commits.filter((c) => c.at <= hi).length,
			workingHours: workingMsOf(sessions, lo, hi) / 3_600_000,
			gateRuns:
				gateRuns === null
					? null
					: gateRuns.filter((r) => inWindow(r.at)).length,
			state: record === null ? null : foldBreakerAt(record, root, hi),
			events:
				record === null
					? null
					: record.filter((e) => e.repo === root && inWindow(e.at)),
		};
	});
}

module.exports = { readThroughput, readThroughputWindow };
