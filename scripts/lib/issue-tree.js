const { gh, ghApiSlurp } = require("./gh");

/**
 * @typedef {{ state?: string, pull_request?: object }} SubIssue
 */

/**
 * @param {{ parent_issue_url?: string | null, repository_url?: string }} iss
 * @returns {number | null}
 */
function localParentOf(iss) {
	const m = /^(.*)\/issues\/(\d+)$/.exec(String(iss.parent_issue_url ?? ""));
	if (!m) return null;
	if (iss.repository_url && m[1] !== iss.repository_url) return null;
	return Number(m[2]);
}

/**
 * @param {number} n
 * @param {string} [repo]
 * @param {import("node:child_process").ExecFileSyncOptions} [opts]
 * @param {import("./gh.js").GhRun} [run]
 * @returns {any[]}
 */
const readSubIssues = (n, repo = "{owner}/{repo}", opts = {}, run = gh) =>
	ghApiSlurp([`repos/${repo}/issues/${n}/sub_issues`], opts, run);

/** @param {number} map */
const buildArchiveContainerTitle = (map) =>
	`Archive: closed children of #${map}`;

/** @param {{ sub_issues_summary?: { total?: number } }} k */
const subIssueTotal = (k) => k.sub_issues_summary?.total ?? 0;

/** @param {SubIssue} k */
const isOpenChild = (k) => k.state === "open" && !k.pull_request;

module.exports = {
	buildArchiveContainerTitle,
	localParentOf,
	readSubIssues,
	isOpenChild,
	subIssueTotal,
};
