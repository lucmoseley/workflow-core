const fs = require("node:fs");
const path = require("node:path");
const { readCommitsBy } = require("./arbiter-ledger.js");
const { orFallback, parseErrorText } = require("./caught.js");
const { readText } = require("./file-read.js");
const { gateRunLogPath, readGateRunsAt } = require("./gate-seat.js");
const { gitOrNull } = require("./git.js");
const { jobDirPath, readJobCwd, shortJobId } = require("./job-paths.js");
const { parseJsonl } = require("./jsonl.js");
const { ownQueueName } = require("./landing-refs.js");
const { isLoopJob, jobKeyOf, loopJobsPath } = require("./loop-jobs.js");
const { queueGit } = require("./queue-lander-adapters.js");
const { queueLogFile, readQueueRows } = require("./queue-log.js");
const { readQueueStays } = require("./queue-ref-status.js");
const { readConfig } = require("./workflow-core-config.js");
const {
	SILENCE_CAP_MS,
	breakerRecordPath,
	foldBreakerAt,
	sessionIdsOf,
	workingMsOf,
} = require("./refill-breaker.js");

/* #5275 guess: one git log, reflog or ancestry read on a fetched repo, short of a stall. */
const GIT_LOG_TIMEOUT_MS = 20_000;

/**
 * @typedef {import("./refill-breaker.js").BreakerLaunch & {seat: string,
 *  copiedFrom?: string}} SeatedLaunch
 * @typedef {import("./refill-breaker.js").SessionTimeline} SessionTimeline
 * @typedef {import("./loop-jobs.js").TimedJob} TimedJob
 * @typedef {import("./refill-breaker.js").BreakerEvent} BreakerEvent
 * @typedef {import("./gate-seat.js").GateRun} GateRun
 * @typedef {import("./refill-breaker.js").TrialQueue} TrialQueue
 * @typedef {{checkout: string, commits: number|null, workingHours: number,
 *  jobsRead: boolean, timelinesUnread: string[],
 *  gateRuns: number|null, state: import("./refill-breaker.js").BreakerState|null,
 *  events: BreakerEvent[]|null}} RepoThroughput
 */

/** @param {string} root @param {number} since @returns {{sha: string, at: number}[]|null} */
function readMainCommits(root, since) {
	const out = gitOrNull(
		[
			"-C",
			root,
			"log",
			"origin/main",
			"--no-merges",
			`--max-age=${Math.floor(since / 1000)}`,
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

/** @param {string|null} file @returns {Record<string, unknown>[]|null} */
function readRows(file) {
	if (file === null) return null;
	const read = readText(file);
	if (read.state === "absent") return [];
	return read.state === "read" ? parseJsonl(read.data).rows : null;
}

/** @param {string} root @returns {GateRun[]|null} */
const readGateRuns = (root) => readGateRunsAt(gateRunLogPath(root));

/**
 * @param {string} root
 * @returns {string|null}
 */
const readSuiteCommand = (root) =>
	orFallback(
		() => readConfig({ root, quiet: true }).commands?.test ?? null,
		null,
	);

/** @returns {BreakerEvent[]|null} */
const readBreakerRecord = () =>
	/** @type {BreakerEvent[]|null} */ (readRows(breakerRecordPath()));

/**
 * @param {TimedJob} job
 * @param {number} since
 * @returns {SessionTimeline|{unread: string}|null}
 */
function readJobTimeline({ seat, jobId, endAt }, since) {
	const file = path.join(jobDirPath(seat, jobId), "timeline.jsonl");
	const unread = (/** @type {string} */ message) => ({
		unread: `job ${jobId}'s timeline (${message})`,
	});
	let stat;
	try {
		stat = fs.statSync(file, { throwIfNoEntry: false });
	} catch (err) {
		return unread(parseErrorText(err));
	}
	if (stat === undefined || stat.mtimeMs < since) return null;
	const read = readText(file);
	if (read.state === "absent") return null;
	if (read.state === "unreadable") return unread(read.message);
	return {
		rows: parseJsonl(read.data).rows.flatMap((r) =>
			typeof r.at === "string" && typeof r.state === "string"
				? [{ at: r.at, state: r.state }]
				: [],
		),
		endAt,
	};
}

/** @param {SeatedLaunch} l @returns {string[]} */
const lineageOf = (l) =>
	[l.copiedFrom, ...[...sessionIdsOf(l)].map(shortJobId)].flatMap((id) =>
		id === undefined || id === l.jobId ? [] : [id],
	);

/**
 * @param {Record<string, unknown>[]} record
 * @returns {Map<string, TimedJob & {endedAt: number|null}>}
 */
function foldLoopJobs(record) {
	const jobs = new Map();
	for (const r of record)
		if (isLoopJob(r))
			jobs.set(String(jobKeyOf(r)), {
				root: r.repo,
				seat: r.seat,
				jobId: r.jobId,
				endAt: 0,
				endedAt: r.endedAt === undefined ? null : Date.parse(r.endedAt),
			});
	return jobs;
}

/** @param {SeatedLaunch[]} launches @param {number} now @returns {TimedJob[]} */
const launchJobsOf = (launches, now) => [
	...launches.flatMap((l) =>
		l.jobId === null
			? []
			: [{ ...l, jobId: l.jobId, endAt: l.finishedAt ?? now }],
	),
	...launches.flatMap((l) =>
		lineageOf(l).map((jobId) => ({ ...l, jobId, endAt: now })),
	),
];

/**
 * @param {{roots: string[], launches: SeatedLaunch[],
 *  lookbackOf: (root: string) => number, now: number}} window
 * @returns {{byRoot: Record<string, {sessions: SessionTimeline[],
 *  timelinesUnread: string[]}>, recordRead: boolean}}
 */
function readLoopSessions({ roots, launches, lookbackOf, now }) {
	const record = readRows(loopJobsPath());
	const recorded = foldLoopJobs(record ?? []);
	/** @type {Map<string, TimedJob>} */
	const timed = new Map();
	for (const job of [
		...launchJobsOf(launches, now),
		...[...recorded.values()].map((j) => ({ ...j, endAt: now })),
	]) {
		const key = String(jobKeyOf(job));
		if (!timed.has(key))
			timed.set(key, {
				root: job.root,
				seat: job.seat,
				jobId: job.jobId,
				endAt: recorded.get(key)?.endedAt ?? job.endAt,
			});
	}
	/** @param {string} root */
	const readRoot = (root) => {
		const reads = [...timed.values()]
			.filter((j) => j.root === root && j.endAt > lookbackOf(root))
			.flatMap(
				(j) => readJobTimeline(j, lookbackOf(root) - SILENCE_CAP_MS) ?? [],
			);
		return {
			sessions: reads.flatMap((r) => ("unread" in r ? [] : [r])),
			timelinesUnread: reads.flatMap((r) => ("unread" in r ? [r.unread] : [])),
		};
	};
	return {
		byRoot: Object.fromEntries(roots.map((root) => [root, readRoot(root)])),
		recordRead: record !== null,
	};
}

/**
 * @param {Iterable<string>} ids
 * @param {string} root
 * @returns {string[]|null}
 */
function readCommitsByEach(ids, root) {
	const shas = [];
	for (const id of ids) {
		const mine = readCommitsBy(id, root);
		if (mine === null) return null;
		shas.push(...mine);
	}
	return shas;
}

/**
 * @param {import("./refill-breaker.js").BreakerLaunch} l
 */
const readCommitsOf = (l) => readCommitsByEach(sessionIdsOf(l), l.root);

/** @param {import("./queue-ref-status.js").RefState[]} stays @returns {TrialQueue} */
function trialQueueOf(stays) {
	if (stays.some((s) => s.state === "landed")) return { state: "landed" };
	if (stays.some((s) => s.state === "queued" || s.state === "testing"))
		return { state: "waiting" };
	const unread = stays.find(
		(s) => s.state === "unread" || s.state === "unwalked",
	);
	if (unread)
		return {
			state: "unread",
			why: `queue/${unread.name} at ${unread.sha.slice(0, 7)} is queued, under test or landed, which will not read`,
		};
	return { state: "gone" };
}

/** @returns {(l: import("./refill-breaker.js").BreakerLaunch) => TrialQueue} */
function buildQueueReader() {
	/** @type {Map<string, {refs: import("./queue-lander.js").QueueRefs,
	 *   rows: import("./queue-log.js").LoggedRow[]}>} */
	const landers = new Map();
	/** @param {string} root */
	const readLander = (root) => {
		const known = landers.get(root);
		if (known) return known;
		// #5273
		const read = {
			refs: queueGit(root).refs(),
			rows: readQueueRows(queueLogFile(root)),
		};
		landers.set(root, read);
		return read;
	};
	return (l) => {
		try {
			const cwd = l.jobId === null ? null : readJobCwd(l.seat, l.jobId);
			if (cwd === null)
				return { state: "unread", why: "its job record names no worktree" };
			const name = ownQueueName(cwd, l.root);
			if (name === null) return { state: "gone" };
			const { refs, rows } = readLander(l.root);
			return trialQueueOf(
				readQueueStays(l.root, { name, since: l.launchedAt }, refs, rows),
			);
		} catch (err) {
			// #5300
			return {
				state: "unread",
				why: `its queue ref will not read: ${parseErrorText(err)}`,
			};
		}
	};
}

/**
 * @param {{roots: string[], launches: SeatedLaunch[],
 *  lookbackOf: (root: string, record: BreakerEvent[]|null) => number,
 *  now: number}} tick
 * @returns {import("./refill-breaker.js").ThroughputRead}
 */
function readThroughput({ roots, launches, lookbackOf, now }) {
	const record = readBreakerRecord();
	/** @param {string} root */
	const lookback = (root) => lookbackOf(root, record);
	const sessions = readLoopSessions({
		roots,
		launches,
		lookbackOf: lookback,
		now,
	});
	return {
		byRoot: Object.fromEntries(
			roots.map((root) => [
				root,
				{
					commits: readMainCommits(root, lookback(root)),
					gateRuns: readGateRuns(root),
					suiteCommand: readSuiteCommand(root),
					sessions: sessions.byRoot[root]?.sessions ?? [],
					timelinesUnread: sessions.byRoot[root]?.timelinesUnread ?? [],
				},
			]),
		),
		commitsOf: readCommitsOf,
		queueOf: buildQueueReader(),
		record,
	};
}

/**
 * @param {{roots: string[], launches: SeatedLaunch[], lo: number, hi: number}} window
 * @returns {RepoThroughput[]}
 */
function readThroughputWindow({ roots, launches, lo, hi }) {
	const record = readBreakerRecord();
	const sessions = readLoopSessions({
		roots,
		launches,
		lookbackOf: () => lo,
		now: hi,
	});
	/** @param {string} at */
	const inWindow = (at) => Date.parse(at) > lo && Date.parse(at) <= hi;
	return roots.map((root) => {
		const commits = readMainCommits(root, lo);
		const gateRuns = readGateRuns(root);
		return {
			checkout: path.basename(root),
			commits:
				commits === null ? null : commits.filter((c) => c.at <= hi).length,
			workingHours:
				workingMsOf(sessions.byRoot[root]?.sessions ?? [], lo, hi) / 3_600_000,
			jobsRead: sessions.recordRead,
			timelinesUnread: sessions.byRoot[root]?.timelinesUnread ?? [],
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

module.exports = {
	GIT_LOG_TIMEOUT_MS,
	readCommitsByEach,
	readSuiteCommand,
	readThroughput,
	readThroughputWindow,
};
