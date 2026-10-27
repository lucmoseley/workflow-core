/*
 * issue-ref.js — an issue named across repos: read off an API URL, keyed,
 * labelled for a reader, and told apart from another repo's (#3256). Its own
 * module so the blocker readers that need only these do not load the claim
 * store parent-claims.js reads. A word of a `gh issue` command is
 * gh-issue-ref.js's to read, not this file's.
 *
 * A CORE: it reads nothing but its arguments.
 */

/** @typedef {{repo: string|null, number: number}} IssueRef */

/**
 * The issue an API issue URL names. `repo` is null where the URL carries no
 * `/repos/<owner>/<name>/` part, read as the candidate's own repo.
 * @param {string|null|undefined} url
 * @returns {IssueRef|null}
 */
function parseIssueRef(url) {
	if (!url) return null;
	const m = String(url).match(/\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/?$/);
	if (m) return { repo: m[1] ?? null, number: Number(m[2]) };
	const n = Number(String(url).split("/").pop());
	return Number.isInteger(n) && n > 0 ? { repo: null, number: n } : null;
}

/**
 * `owner/name` from a `repository_url`, or null.
 * @param {string|null|undefined} url
 */
function parseRepoOfUrl(url) {
	const m = url ? String(url).match(/\/repos\/([^/]+\/[^/]+)\/?$/) : null;
	return m?.[1] ?? null;
}

/** @param {string|null} a @param {string|null} b */
const isSameRepo = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Whether `ref` lives in a repo other than `childRepo`. A ref naming no repo
 * is the child's own.
 * @param {IssueRef} ref
 * @param {string|null} childRepo
 */
const isInOtherRepo = (ref, childRepo) =>
	!!ref.repo && !isSameRepo(ref.repo, childRepo);

/**
 * How a reader sees `ref` from an issue in `childRepo`: `#n` in the same repo,
 * `owner/name#n` in another.
 * @param {IssueRef} ref
 * @param {string|null} childRepo
 */
const refLabel = (ref, childRepo) =>
	isInOtherRepo(ref, childRepo)
		? `${ref.repo}#${ref.number}`
		: `#${ref.number}`;

/**
 * One key per issue across repos, case-folded as GitHub folds a repo name; a
 * ref naming no repo keys as `#n`.
 * @param {IssueRef} ref
 */
const refKey = (ref) => `${(ref.repo ?? "").toLowerCase()}#${ref.number}`;

module.exports = {
	isInOtherRepo,
	isSameRepo,
	parseIssueRef,
	parseRepoOfUrl,
	refKey,
	refLabel,
};
