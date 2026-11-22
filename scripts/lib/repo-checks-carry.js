const { isCompleted, keysOf } = require("./key-delta");
const { entryOf } = require("./repo-checks-registry");

// guess, #1510
const FIRST_SINCE_DAYS = 30;
const DAY_MS = 24 * 3_600_000;

/**
 * @typedef {import("./repo-checks-registry").RepoCheck} RepoCheck
 * @typedef {{ job: string, outcome: string, keys?: unknown }} CarriedJob
 */

/**
 * @typedef {{ lastStarts: Record<string, unknown>,
 *   rescans: Record<string, unknown>, startMs: number }} Kept
 */

/**
 * @param {{ keys?: unknown }} job
 * @returns {number[]}
 */
const issuesOf = (job) =>
	[
		...new Set(
			keysOf(job).flatMap((k) => {
				const m = /(?:^|\t)#(\d+)(?:\t|$)/.exec(k);
				return m ? [Number(m[1])] : [];
			}),
		),
	].sort((a, b) => a - b);

/**
 * @param {unknown} last
 * @param {number} startMs
 */
function sinceDays(last, startMs) {
	const t = typeof last === "string" ? Date.parse(last) : Number.NaN;
	if (Number.isNaN(t)) return FIRST_SINCE_DAYS;
	return Math.max(0, Math.ceil((startMs - t) / DAY_MS)) + 1;
}

/**
 * @param {RepoCheck} entry
 * @param {Kept} kept
 * @returns {string[]}
 */
function carriedArgs(entry, { lastStarts, rescans, startMs }) {
	const out = entry.since
		? ["--since", String(sinceDays(lastStarts[entry.id], startMs))]
		: [];
	const kept = entry.rescan ? rescans[entry.id] : undefined;
	const issues = Array.isArray(kept)
		? kept.filter((n) => Number.isInteger(n) && Number(n) > 0)
		: [];
	if (issues.length > 0) out.push("--rescan", issues.join(","));
	return out;
}

/**
 * @param {CarriedJob[]} jobs
 * @param {Kept} kept
 * @returns {Array<["starts" | "rescans", Record<string, unknown>]>}
 */
function carriedNext(jobs, { lastStarts, rescans, startMs }) {
	/**
	 * @param {"since" | "rescan"} field
	 * @param {"starts" | "rescans"} name
	 * @param {Record<string, unknown>} last
	 * @param {(j: CarriedJob) => unknown} carried
	 * @returns {Array<["starts" | "rescans", Record<string, unknown>]>}
	 */
	const carry = (field, name, last, carried) => {
		const completed = jobs.filter(
			(j) => isCompleted(j.outcome) && entryOf(j.job)[field] === true,
		);
		if (completed.length === 0) return [];
		const next = { ...last };
		for (const j of completed) next[j.job] = carried(j);
		return [[name, next]];
	};
	const start = new Date(startMs).toISOString();
	return [
		...carry("since", "starts", lastStarts, () => start),
		...carry("rescan", "rescans", rescans, issuesOf),
	];
}

module.exports = {
	FIRST_SINCE_DAYS,
	carriedArgs,
	carriedNext,
};
