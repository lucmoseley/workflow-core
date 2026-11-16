/*
 * loop-jobs.js — the record of every job the refill loop's state has named
 * (#5289), with its checkout and seat: a line when the state first names it or
 * a finished launch's job runs again, and a line with `endedAt` when its launch
 * finishes or moves to a copy, the replaced job ending at that write. The
 * throughput breaker and the morning review count a checkout's working hours
 * off it, since the state keeps only its latest finished launches and a resume
 * into a copy moves a launch to a new job.
 *
 * Neither source the loop already keeps will do: the dispatch ledger names no
 * seat, and a copy keeps its original's ledger row; the job store does not
 * tell a loop job from any other in the checkout.
 *
 * Kept as long as the breaker record, so the morning review's window reaches
 * as far back in both. Written by lib/refill-state.js's updateState, the
 * state's one write, so a job reaches it by whatever route it entered the
 * state.
 */

const { BREAKER_RETAIN_MS } = require("./refill-breaker.js");
const { refillPath } = require("./refill-dir.js");
const { appendRetained } = require("./retained-jsonl.js");

/**
 * @typedef {{at: string, repo: string, seat: string, jobId: string,
 *   endedAt?: string}} LoopJob  `at` when written
 * @typedef {{root: string, seat: string, jobId: string|null,
 *   finishedAt: number|null}} JobOwner  a launch, as the record reads it
 * @typedef {{root: string, seat: string, jobId: string, endAt: number}} TimedJob
 *   a job and the time its last timeline row counts to
 */

const loopJobsPath = () => refillPath(".refill-jobs.jsonl");

/**
 * A job's key across seats; null for a launch with no job yet.
 * @param {{seat: string, jobId: string|null}} j
 */
const jobKeyOf = (j) => (j.jobId ? `${j.seat}\0${j.jobId}` : null);

/**
 * `launches` by their jobs' keys.
 * @param {JobOwner[]} launches
 * @returns {Map<string, JobOwner>}
 */
const byJob = (launches) =>
	new Map(
		launches.flatMap((l) => {
			const key = jobKeyOf(l);
			return key === null ? [] : [[key, l]];
		}),
	);

/**
 * The lines a state write from `was` to `is` owes: each job that starts or
 * runs again, and each that ends, a job gone unfinished ending `now`.
 * @param {Map<string, JobOwner>} was
 * @param {Map<string, JobOwner>} is
 * @param {number} now
 * @returns {{l: JobOwner, endedAt?: number}[]}
 */
function linesOf(was, is, now) {
	const lines = [];
	for (const [key, l] of is) {
		const prior = was.get(key);
		const done = l.finishedAt !== null;
		if (!prior || (prior.finishedAt !== null && !done)) lines.push({ l });
		if (done && (!prior || prior.finishedAt === null))
			lines.push({ l, endedAt: Number(l.finishedAt) });
	}
	for (const [key, l] of was)
		if (!is.has(key) && l.finishedAt === null) lines.push({ l, endedAt: now });
	return lines;
}

/**
 * Append the lines a state write from `before` to `after` owes (linesOf).
 * Never throws: a line it cannot take is logged.
 * @param {JobOwner[]} before
 * @param {JobOwner[]} after
 * @param {{now: number, log: (line: string) => void}} at
 */
function recordJobs(before, after, { now, log }) {
	for (const { l, endedAt } of linesOf(byJob(before), byJob(after), now)) {
		/** @type {LoopJob} */
		const row = {
			at: new Date(now).toISOString(),
			repo: l.root,
			seat: l.seat,
			jobId: String(l.jobId),
			...(endedAt === undefined
				? {}
				: { endedAt: new Date(endedAt).toISOString() }),
		};
		if (!appendRetained(loopJobsPath(), row, BREAKER_RETAIN_MS))
			log(`loop-job record would not take job ${l.jobId} in ${l.root}`);
	}
}

/**
 * @param {Record<string, unknown>} r
 * @returns {r is LoopJob}
 */
const isLoopJob = (r) =>
	typeof r.at === "string" &&
	typeof r.repo === "string" &&
	typeof r.seat === "string" &&
	typeof r.jobId === "string" &&
	(r.endedAt === undefined || typeof r.endedAt === "string");

module.exports = { isLoopJob, jobKeyOf, loopJobsPath, recordJobs };
