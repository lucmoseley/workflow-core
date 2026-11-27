const { TERMINAL_STATES: JOB_STATE_TERMINAL } = require("./agent-liveness.js");
const { buildHeldText, entryHolds } = require("./dispatch-ledger.js");

/** @typedef {import("./dispatch-ledger.js").DispatchRecord} DispatchRecord */
/** @typedef {import("./agent-liveness.js").ListedSessions} ListedSessions */
/** @typedef {ReturnType<typeof import("./hung-jobs.js").readJobs>} Jobs */

/**
 * @param {{byIssue: Map<number, DispatchRecord[]>}} dispatched
 * @param {number} n
 * @param {string[]} takes
 * @returns {DispatchRecord|undefined}
 */
function holdingDispatch(dispatched, n, takes) {
	return (dispatched.byIssue.get(n) || []).findLast(
		(rec) => takes.length === 0 || takes.some((t) => entryHolds(rec, t)),
	);
}

/**
 * @param {DispatchRecord|undefined} rec
 * @param {number} now
 * @returns {string}
 */
function dispatchAge(rec, now) {
	const at = rec ? Date.parse(rec.ts) : Number.NaN;
	const age = Number.isNaN(at)
		? "at an unreadable time"
		: `${Math.max(0, (now - at) / 3_600_000).toFixed(1)}h ago`;
	return `${age}${buildHeldText(rec)} — ${rec?.prompt || "prompt not recorded"}`;
}

/**
 * @param {Jobs} jobs
 * @param {string} jobId
 */
function jobRecordOf(jobs, jobId) {
	if (!Array.isArray(jobs)) return null;
	return jobs.find((j) => j.job === jobId) || null;
}

/**
 * @param {DispatchRecord|undefined} rec
 * @param {ListedSessions} listed
 * @param {Jobs} jobs
 * @returns {{state: "live", detail?: undefined, why?: undefined}|{state: "finished", detail: string, why?: undefined}|{state: "unknown", why: string, detail?: undefined}}
 */
function dispatchLiveness(rec, listed, jobs) {
	if (!rec?.jobId)
		return { state: "unknown", why: "no job id recorded on this entry" };
	const job = jobRecordOf(jobs, rec.jobId);
	if (!job)
		return {
			state: "unknown",
			why:
				jobs === null
					? "no job store could be read"
					: `no job record found for ${rec.jobId}`,
		};
	if (job.unreadable || !job.rec)
		return { state: "unknown", why: `job record for ${rec.jobId} unreadable` };
	const jobState = job.rec.state;
	if (JOB_STATE_TERMINAL.has(jobState))
		return {
			state: "finished",
			detail:
				typeof job.rec.detail === "string" && job.rec.detail
					? job.rec.detail
					: jobState,
		};
	const sessionId =
		typeof job.rec.sessionId === "string" ? job.rec.sessionId : null;
	if (!sessionId)
		return { state: "unknown", why: "the job record carries no session id" };
	if (!listed.ids)
		return {
			state: "unknown",
			why: `the oracle could not be read: ${listed.why}`,
		};
	if (listed.terminal.has(sessionId))
		return { state: "finished", detail: "oracle reads it terminal" };
	if (listed.ids.has(sessionId)) return { state: "live" };
	return {
		state: "unknown",
		why: "the oracle does not list this session, and its job record reads neither live nor terminal",
	};
}

/**
 * @param {ReturnType<typeof dispatchLiveness>} liveness
 * @returns {string}
 */
function dispatchLivenessLabel(liveness) {
	return liveness.state === "finished"
		? `finished: ${liveness.detail}`
		: liveness.state;
}

/**
 * @param {ReturnType<typeof dispatchLiveness>} liveness
 * @returns {string}
 */
function dispatchLivenessCell(liveness) {
	const label = dispatchLivenessLabel(liveness);
	return liveness.why ? `${label} (${liveness.why})` : label;
}

module.exports = {
	dispatchAge,
	dispatchLiveness,
	dispatchLivenessCell,
	dispatchLivenessLabel,
	holdingDispatch,
};
