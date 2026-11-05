/*
 * pick-next-dispatched.js — what scripts/pick-next.js decides about an issue
 * the launcher has already dispatched (mantahostels#1528): which ledger entry
 * holds it on its current `takes:` value (#752), that launch's age as an
 * exclusion reason, and whether the launch's own job is still alive
 * (mantahostels#3488).
 *
 * Out of pick-next.js so each decision is tested by calling it (#4329). The
 * ledger, the job store and the oracle are read there and handed in; the
 * clock is a parameter too, so an age is asserted without wall time (§X9).
 */

const { TERMINAL_STATES: JOB_STATE_TERMINAL } = require("./agent-liveness.js");
const { buildHeldText, entryHolds } = require("./dispatch-ledger.js");

/** @typedef {import("./dispatch-ledger.js").DispatchRecord} DispatchRecord */
/** @typedef {import("./agent-liveness.js").ListedSessions} ListedSessions */
/** @typedef {ReturnType<typeof import("./hung-jobs.js").readJobs>} Jobs */

/**
 * The ledger entry holding an issue whose `takes:` values are `takes`, or
 * `undefined` where none does. The most recent holder is the one reported,
 * rather than the oldest still inside the window.
 *
 * TWO GAPS. An issue carrying two `takes:` values is held where EITHER matches
 * — a label defect `check-issue-labels.js` reports, read here toward the hold.
 * And the picker compares with the issue's LABEL where the launcher compares
 * with the PROMPT's `/<skill>`: the two agree only because §7 builds each
 * prompt as `/<takes> <n>`, so a set line typed under another command is
 * judged here on the label alone.
 * @param {{byIssue: Map<number, DispatchRecord[]>}} dispatched every entry
 *   inside the window, by issue
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
 * One ledger entry as an exclusion reason, with the launch's age — a reader
 * judging whether an entry is stale needs the age, not the timestamp. An
 * unreadable or absent field says so rather than printing a plausible blank:
 * this line is what a `--force` gets decided on.
 * `undefined` is accepted because the caller reads it out of a Map: the two are
 * the same absence, and both print rather than throwing.
 * @param {DispatchRecord|undefined} rec
 * @param {number} now ms since the epoch
 * @returns {string}
 */
function dispatchAge(rec, now) {
	const at = rec ? Date.parse(rec.ts) : Number.NaN;
	const age = Number.isNaN(at)
		? "at an unreadable time"
		: `${Math.max(0, (now - at) / 3_600_000).toFixed(1)}h ago`;
	return `${age}${buildHeldText(rec)} — ${rec?.prompt || "prompt not recorded"}`;
}

/*
 * Whether an ALREADY DISPATCHED launch's own job is still alive (mantahostels#3488). The
 * ledger holds an issue for the whole window REGARDLESS (pick-next.js's
 * `dispatchedIssues` header), which is what made a finished launch and a
 * running one print identically — this is the join that tells them apart.
 *
 * `JOB_STATE_TERMINAL` is `lib/agent-liveness.js#TERMINAL_STATES`, imported
 * under this name: the job's own `state.json` and the oracle's own session
 * record are two different files, but both are stamped by the SAME CLI code
 * path off the same three words (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/session-state-status-skew.md
 * §F1) — one constant, not two that could drift apart unnoticed.
 */

/**
 * @param {Jobs} jobs
 * @param {string} jobId
 */
function jobRecordOf(jobs, jobId) {
	if (!Array.isArray(jobs)) return null;
	return jobs.find((j) => j.job === jobId) || null;
}

/**
 * `{state: "live"}`, `{state: "finished", detail}` off the job's own
 * `state.json`, or `{state: "unknown", why}` — never a guess at liveness from
 * an absence.
 *
 * READS TWO SOURCES, NEITHER SUFFICIENT ALONE. The job's `state.json` can read
 * `working` for a session that has since died with no update (`lib/hung-jobs.js`'s
 * own HUNG-JOB case) — so `working` alone is not "live", it is "ask the
 * oracle". The oracle in turn is keyed by SESSION id, not the JOB id the
 * ledger records, so the job's own record is what supplies that session id to
 * look up.
 *
 * A reachable job record that already reads a terminal state is trusted
 * outright, with no oracle read at all: `done`/`failed`/`stopped` do not need
 * confirming, and a session the oracle no longer lists (finished long enough
 * ago to fall out of `claude agents --json`) would otherwise read as
 * "unknown" rather than "finished" (mantahostels#3488's own worked example, `e6736764` and
 * `4f9cd281`).
 *
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
	// Narrowed on `.ids` rather than on `.why` (mantahostels#1460's own reasoning,
	// matching `reclaimableFrom` in lib/pick-next-sessions.js): `why` is a plain
	// `string` in the refused shape, so a truthy check on it leaves an
	// empty-string refusal still typed as possibly-refused, and
	// `.terminal`/`.ids` possibly undefined below. `ids` is present only in the
	// listed shape.
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
 * `live`, `finished: <detail>` or `unknown` — the exact text both the table
 * and `--json` print, so the two cannot drift on wording.
 * @param {ReturnType<typeof dispatchLiveness>} liveness
 * @returns {string}
 */
function dispatchLivenessLabel(liveness) {
	return liveness.state === "finished"
		? `finished: ${liveness.detail}`
		: liveness.state;
}

module.exports = {
	dispatchAge,
	dispatchLiveness,
	dispatchLivenessLabel,
	holdingDispatch,
};
