/*
 * loop-jobs.js — the record of every job the refill loop's state has named
 * (#5289): one line per job, when the state first names it, with its checkout
 * and seat. The throughput breaker and the morning review count a checkout's
 * working hours off it, since the state keeps only its latest finished
 * launches and a resume into a copy moves a launch to a new job.
 *
 * Neither source the loop already keeps will do: the dispatch ledger names no
 * seat, and a copy keeps its original's ledger row; the job store does not
 * tell a loop job from any other in the checkout.
 *
 * Written by lib/refill-state.js's updateState, the state's one write, so a
 * job reaches it by whatever route it entered the state.
 */

const { refillPath } = require("./refill-dir.js");
const { appendRetained } = require("./retained-jsonl.js");

/* The breaker record's retention (lib/refill-breaker.js), so the morning
 * review's window reaches as far back in both. */
const LOOP_JOBS_RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * @typedef {{at: string, repo: string, seat: string, jobId: string}} LoopJob
 *   `at` when the state first named it
 * @typedef {{root: string, seat: string, jobId: string|null}} JobOwner
 */

const loopJobsPath = () => refillPath(".refill-jobs.jsonl");

/** @param {{seat: string, jobId: string}} j */
const jobKeyOf = (j) => `${j.seat}\0${j.jobId}`;

/**
 * Append each job `after` names that `before` does not. Never throws: a job it
 * cannot take is logged.
 * @param {JobOwner[]} before
 * @param {JobOwner[]} after
 * @param {{now: number, log: (line: string) => void}} at
 */
function recordNewJobs(before, after, { now, log }) {
	const known = new Set(
		before.flatMap((l) =>
			l.jobId ? [jobKeyOf({ ...l, jobId: l.jobId })] : [],
		),
	);
	for (const l of after) {
		if (!l.jobId) continue;
		const key = jobKeyOf({ ...l, jobId: l.jobId });
		if (known.has(key)) continue;
		known.add(key);
		/** @type {LoopJob} */
		const row = {
			at: new Date(now).toISOString(),
			repo: l.root,
			seat: l.seat,
			jobId: l.jobId,
		};
		if (!appendRetained(loopJobsPath(), row, LOOP_JOBS_RETAIN_MS))
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
	typeof r.jobId === "string";

module.exports = { isLoopJob, jobKeyOf, loopJobsPath, recordNewJobs };
