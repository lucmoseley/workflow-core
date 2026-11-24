const { BREAKER_RETAIN_MS } = require("./refill-breaker.js");
const { refillPath } = require("./refill-dir.js");
const { appendRetained } = require("./retained-jsonl.js");

/**
 * @typedef {{at: string, repo: string, seat: string, jobId: string,
 *   endedAt?: string}} LoopJob
 * @typedef {{root: string, seat: string, jobId: string|null,
 *   finishedAt: number|null}} JobOwner
 * @typedef {{root: string, seat: string, jobId: string, endAt: number}} TimedJob
 */

const loopJobsPath = () => refillPath(".refill-jobs.jsonl");

/**
 * @param {{seat: string, jobId: string|null}} j
 */
const jobKeyOf = (j) => (j.jobId ? `${j.seat}\0${j.jobId}` : null);

/**
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
		if (
			!appendRetained(loopJobsPath(), row, BREAKER_RETAIN_MS, {
				now: () => now,
			})
		)
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
