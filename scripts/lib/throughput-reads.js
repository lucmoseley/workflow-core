/*
 * throughput-reads.js — the reads the throughput breaker, the gate-run budget
 * (lib/refill-breaker.js, lib/refill-budget.js) and the morning review's
 * Throughput section share (#5275).
 */

const fs = require("node:fs");
const path = require("node:path");
const { readCommitsBy } = require("./arbiter-ledger.js");
const { parseErrorText } = require("./caught.js");
const { readText } = require("./file-read.js");
const { gateRunLogPath } = require("./gate-seat.js");
const { gitOrNull } = require("./git.js");
const { jobDirPath, readJobCwd, shortJobId } = require("./job-paths.js");
const { parseJsonl } = require("./jsonl.js");
const { ownQueueName } = require("./landing-refs.js");
const { isLoopJob, jobKeyOf, loopJobsPath } = require("./loop-jobs.js");
const { queueGit } = require("./queue-lander-adapters.js");
const { queueLogFile, readQueueRows } = require("./queue-log.js");
const { readQueueStays } = require("./queue-ref-status.js");
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
 * @typedef {import("./loop-jobs.js").TimedJob} TimedJob
 * @typedef {import("./refill-breaker.js").BreakerEvent} BreakerEvent
 * @typedef {import("./gate-seat.js").GateRun} GateRun
 * @typedef {import("./refill-breaker.js").TrialQueue} TrialQueue
 * @typedef {{checkout: string, commits: number|null, workingHours: number,
 *   jobsRead: boolean, timelinesUnread: string[],
 *   gateRuns: number|null, state: import("./refill-breaker.js").BreakerState|null,
 *   events: BreakerEvent[]|null}} RepoThroughput a served checkout's window for
 *   the morning review: its commits on `origin/main`, its loop sessions'
 *   working hours, whether the loop-job record read (where not, the hours
 *   are the state's launches' alone), each job timeline that would not read
 *   and so counts no hours, its gate runs, its breaker's state at the window's end and the record's events in
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
 * where it is absent or was last written before `since`, and why where it
 * will not read (#5301).
 * @param {TimedJob} job
 * @param {number} since ms
 * @returns {SessionTimeline|{unread: string}|null}
 */
function readJobTimeline({ seat, jobId, endAt }, since) {
	const file = path.join(jobDirPath(seat, jobId), "timeline.jsonl");
	const unread = (/** @type {string} */ message) => ({
		unread: `job ${jobId}'s timeline (${message})`,
	});
	/* A stat first: a job with no recorded end may have stopped long before. */
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
 * The end the loop-job record gives each job it names, null for one it records
 * no end of since its last start.
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

/**
 * The jobs `launches` name.
 * @param {SeatedLaunch[]} launches
 * @param {number} now
 * @returns {TimedJob[]}
 */
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
 * Each of `roots`' loop sessions that may have worked after
 * `lookbackOf(root)`, as job timelines (#5289): every job the loop-job record
 * names in the checkout, and every job `launches` names there, which covers
 * one the record predates or would not take. A job's last row counts to the end the record gives it, else
 * to its launch's finish where it is that launch's current job, else to `now`.
 * @param {{roots: string[], launches: SeatedLaunch[],
 *   lookbackOf: (root: string) => number, now: number}} window
 * @returns {{byRoot: Record<string, {sessions: SessionTimeline[],
 *   timelinesUnread: string[]}>, recordRead: boolean}}  `timelinesUnread`,
 *   each job timeline that would not read
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
 * The shas `l`'s sessions committed in its checkout, null where a ledger will
 * not read.
 * @param {import("./refill-breaker.js").BreakerLaunch} l
 * @returns {string[]|null}
 */
function readCommitsOf(l) {
	const shas = [];
	for (const id of sessionIdsOf(l)) {
		const mine = readCommitsBy(id, l.root);
		if (mine === null) return null;
		shas.push(...mine);
	}
	return shas;
}

/**
 * Where the stays of a queue ref stand for a breaker trial: one landed, one
 * queued or under test, none left, or no reading where a stay's batch record
 * or `main` will not read.
 * @param {import("./queue-ref-status.js").RefState[]} stays
 * @returns {TrialQueue}
 */
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

/**
 * A reader of where a launch's queue ref stands (#5300): its job's worktree
 * names it, `queue/<worktree name>`, and its stays since the launch are read
 * off its checkout's lander. The remote's refs and the queue log are read once
 * a checkout.
 * @returns {(l: import("./refill-breaker.js").BreakerLaunch) => TrialQueue}
 */
function buildQueueReader() {
	/** @type {Map<string, {refs: import("./queue-lander.js").QueueRefs,
	 *   rows: import("./queue-log.js").LoggedRow[]}>} */
	const landers = new Map();
	/** @param {string} root */
	const readLander = (root) => {
		const known = landers.get(root);
		if (known) return known;
		/* An absent queue log reads as no rows (#5273): the pre-push hook
		 * writes it on every push, but fails open, so a push it missed is
		 * still read off the remote's queue ref. */
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
			/* A session run outside the checkout's worktrees has no queue ref,
			 * so nothing of it can land (#5300). */
			if (name === null) return { state: "gone" };
			const { refs, rows } = readLander(l.root);
			return trialQueueOf(
				readQueueStays(l.root, { name, since: l.launchedAt }, refs, rows),
			);
		} catch (err) {
			/* Any fault holds the trial, so a reading that failed never
			 * reopens a breaker that a landing would close (#5300). */
			return {
				state: "unread",
				why: `its queue ref will not read: ${parseErrorText(err)}`,
			};
		}
	};
}

/**
 * A tick's ThroughputRead for `roots`, each checkout's commits and loop
 * sessions read back to `lookbackOf(root)`.
 * @param {{roots: string[], launches: SeatedLaunch[],
 *   lookbackOf: (root: string, record: BreakerEvent[]|null) => number,
 *   now: number}} tick  `record`, the breaker's, as this read takes it
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
 * Each served checkout's throughput over [lo, hi] for the morning review
 * (#5275). A loop session counts where it worked in the window; one whose
 * timeline will not read counts no hours and is named.
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

module.exports = { readThroughput, readThroughputWindow };
