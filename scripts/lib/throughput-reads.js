/*
 * throughput-reads.js — the reads the throughput breaker, the gate-run budget
 * (lib/refill-breaker.js, lib/refill-budget.js) and the morning review's
 * Throughput section share (#5275): a checkout's non-merge `origin/main`
 * commits, its gate-run record, a loop session's job timeline and commits, and
 * the breaker's record. Each read that fails is null, never "none".
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { readCommitsBy } = require("./arbiter-ledger.js");
const { gateRunLogPath } = require("./gate-seat.js");
const { gitOrNull } = require("./git.js");
const { jobDirPath } = require("./job-paths.js");
const { parseJsonl } = require("./jsonl.js");
const { breakerRecordPath } = require("./refill-breaker.js");

/** Long enough for a fetched repo's log since a day back, short of a stall. */
const GIT_LOG_TIMEOUT_MS = 20_000;

/**
 * @typedef {import("./refill-breaker.js").BreakerLaunch & {seat: string}} SeatedLaunch
 * @typedef {import("./refill-breaker.js").BreakerEvent} BreakerEvent
 * @typedef {import("./gate-seat.js").GateRun} GateRun
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
	try {
		return parseJsonl(fs.readFileSync(file, "utf8")).rows;
	} catch (e) {
		return caught(e).code === "ENOENT" ? [] : null;
	}
}

/**
 * `root`'s gate-run record (lib/gate-seat.js); null where it will not read.
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
	[...(l.pastSessionIds ?? []), ...(l.sessionId ? [l.sessionId] : [])].flatMap(
		(id) => readCommitsBy(id, l.root) ?? [],
	);

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

module.exports = {
	readBreakerRecord,
	readGateRuns,
	readMainCommits,
	readSessionTimeline,
	readThroughput,
};
