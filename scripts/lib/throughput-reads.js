/*
 * throughput-reads.js — the reads the throughput breaker, the gate-run budget
 * (lib/refill-breaker.js, lib/refill-budget.js) and the morning review's
 * Throughput section share (#5275).
 */

const fs = require("node:fs");
const path = require("node:path");
const { readCommitsBy } = require("./arbiter-ledger.js");
const { readText } = require("./file-read.js");
const { gateRunLogPath } = require("./gate-seat.js");
const { gitOrNull } = require("./git.js");
const { jobDirPath, shortJobId } = require("./job-paths.js");
const { parseJsonl } = require("./jsonl.js");
const { isLoopJob, jobKeyOf, loopJobsPath } = require("./loop-jobs.js");
const {
	SILENCE_CAP_MS,
	breakerRecordPath,
	foldBreakerAt,
	sessionIdsOf,
	workingMsOf,
} = require("./refill-breaker.js");

/** A guess: long enough for a fetched repo's log over the lookback, short of a stall. */
const GIT_LOG_TIMEOUT_MS = 20_000;

/**
 * @typedef {import("./refill-breaker.js").BreakerLaunch & {seat: string,
 *   copiedFrom?: string}} SeatedLaunch
 * @typedef {import("./refill-breaker.js").SessionTimeline} SessionTimeline
 * @typedef {import("./refill-breaker.js").BreakerEvent} BreakerEvent
 * @typedef {import("./gate-seat.js").GateRun} GateRun
 * @typedef {{checkout: string, commits: number|null, workingHours: number|null,
 *   gateRuns: number|null, state: import("./refill-breaker.js").BreakerState|null,
 *   events: BreakerEvent[]|null}} RepoThroughput a served checkout's window for
 *   the morning review: its commits on `origin/main`, its loop sessions'
 *   working hours (null where the loop-job record will not read), its gate
 *   runs, its breaker's state at the window's end and the record's events in
 *   the window
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
 * Job `jobId`'s timeline on `seat`, its last row counted to `endAt`; null
 * where it is absent, will not read, or was last written before `since`.
 * @param {{seat: string, jobId: string, endAt: number}} job
 * @param {number} since ms
 * @returns {SessionTimeline|null}
 */
function readJobTimeline({ seat, jobId, endAt }, since) {
	const file = path.join(jobDirPath(seat, jobId), "timeline.jsonl");
	let mtime;
	try {
		mtime = fs.statSync(file).mtimeMs;
	} catch {
		return null;
	}
	if (mtime < since) return null;
	const rows = readRows(file);
	if (rows === null) return null;
	return {
		rows: rows.flatMap((r) =>
			typeof r.at === "string" && typeof r.state === "string"
				? [{ at: r.at, state: r.state }]
				: [],
		),
		endAt,
	};
}

/**
 * The other jobs `l` has run under on its seat: its copy's original, and
 * those of the sessions it ran under before (#5289).
 * @param {SeatedLaunch} l
 * @returns {string[]}
 */
const lineageOf = (l) =>
	[l.copiedFrom, ...[...sessionIdsOf(l)].map(shortJobId)].flatMap((id) =>
		id === undefined || id === l.jobId ? [] : [id],
	);

/**
 * Each of `roots`' loop sessions that may have worked after `loOf(root)`, as
 * job timelines (#5289): every job the loop-job record names in the checkout,
 * and every job `launches` names there, which covers one the record predates
 * or would not take. A job's last row counts to its launch's finish where it
 * is that launch's current job, else to `hi`. One last written more than the
 * silence cap before the window counts nothing in it, so is not read.
 * Null for every root where the record will not read.
 * @param {{roots: string[], launches: SeatedLaunch[],
 *   loOf: (root: string) => number, hi: number}} window
 * @returns {Record<string, SessionTimeline[]|null>}
 */
function readLoopSessions({ roots, launches, loOf, hi }) {
	const record = readRows(loopJobsPath());
	if (record === null) return Object.fromEntries(roots.map((r) => [r, null]));
	/** @type {Map<string, {root: string, seat: string, jobId: string, endAt: number}>} */
	const jobs = new Map();
	/** @param {{root: string, seat: string, jobId: string, endAt: number}} job */
	const add = (job) => {
		const key = jobKeyOf(job);
		if (!jobs.has(key)) jobs.set(key, job);
	};
	for (const l of launches)
		if (l.jobId !== null)
			add({ ...l, jobId: l.jobId, endAt: l.finishedAt ?? hi });
	for (const l of launches)
		for (const jobId of lineageOf(l)) add({ ...l, jobId, endAt: hi });
	for (const r of record)
		if (isLoopJob(r)) add({ ...r, root: r.repo, endAt: hi });
	return Object.fromEntries(
		roots.map((root) => [
			root,
			[...jobs.values()]
				.filter((j) => j.root === root)
				.flatMap((j) => readJobTimeline(j, loOf(root) - SILENCE_CAP_MS) ?? []),
		]),
	);
}

/**
 * The shas `l`'s sessions committed in its checkout, an unread ledger as none.
 * @param {import("./refill-breaker.js").BreakerLaunch} l
 */
const readCommitsOf = (l) =>
	[...sessionIdsOf(l)].flatMap((id) => readCommitsBy(id, l.root) ?? []);

/**
 * A tick's ThroughputRead for `roots`, each checkout's commits and loop
 * sessions read back to `lookbackOf(root)`.
 * @param {{roots: string[], launches: SeatedLaunch[],
 *   lookbackOf: (root: string) => number, now: number}} tick
 * @returns {import("./refill-breaker.js").ThroughputRead}
 */
function readThroughput({ roots, launches, lookbackOf, now }) {
	const sessions = readLoopSessions({
		roots,
		launches,
		loOf: lookbackOf,
		hi: now,
	});
	return {
		byRoot: Object.fromEntries(
			roots.map((root) => [
				root,
				{
					commits: readMainCommits(root, lookbackOf(root)),
					gateRuns: readGateRuns(root),
					sessions: sessions[root] ?? null,
				},
			]),
		),
		commitsOf: readCommitsOf,
		record: readBreakerRecord(),
	};
}

/**
 * Each served checkout's throughput over [lo, hi] for the morning review
 * (#5275). A loop session counts where it worked in the window; one whose
 * timeline will not read counts no hours.
 * @param {{roots: string[], launches: SeatedLaunch[], lo: number, hi: number}} window
 * @returns {RepoThroughput[]}
 */
function readThroughputWindow({ roots, launches, lo, hi }) {
	const record = readBreakerRecord();
	const sessionsByRoot = readLoopSessions({
		roots,
		launches,
		loOf: () => lo,
		hi,
	});
	/** @param {string} at */
	const inWindow = (at) => Date.parse(at) > lo && Date.parse(at) <= hi;
	return roots.map((root) => {
		const commits = readMainCommits(root, lo);
		const gateRuns = readGateRuns(root);
		const sessions = sessionsByRoot[root] ?? null;
		return {
			checkout: path.basename(root),
			commits:
				commits === null ? null : commits.filter((c) => c.at <= hi).length,
			workingHours:
				sessions === null ? null : workingMsOf(sessions, lo, hi) / 3_600_000,
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
