/*
 * repo-checks-carry.js — what one daily repo-checks reading carries to the
 * next: each `since` entry's window start (#1551) and each `rescan` entry's
 * issue numbers (#1600), turned into the arguments a launch takes, and moved
 * forward only by a reading in which that entry completed. No I/O: the runner,
 * scripts/repo-checks.js, reads and writes the files beside its stamp.
 */

const { isCompleted, keysOf } = require("./key-delta");
const { entryOf } = require("./repo-checks-registry");

/* Spec #1510's first window, the check's own default. */
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
 * The issue numbers a job's keys name: the `#N` field of each.
 *
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
 * The `--since` days for a reading starting at `startMs`: whole days since
 * `last`, rounded up, plus spec #1510's one of overlap. Rounding up alone
 * would not do: the check takes its cutoff from its own clock, up to the
 * run's 30-minute ceiling after `startMs`.
 *
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
	/* Issue numbers only: the check refuses anything else, and a BROKEN
	 * reading never rewrites the list that broke it. */
	const kept = entry.rescan ? rescans[entry.id] : undefined;
	const issues = Array.isArray(kept)
		? kept.filter((n) => Number.isInteger(n) && Number(n) > 0)
		: [];
	if (issues.length > 0) out.push("--rescan", issues.join(","));
	return out;
}

/**
 * What this reading leaves for the next, one pair per file to write. A file
 * none of whose entries completed has no pair, so the runner leaves it as it
 * was.
 *
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
