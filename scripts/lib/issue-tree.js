/*
 * issue-tree.js — an issue's parent in its own repository, and its
 * sub-issues in every repository (#778).
 *
 * `parent_issue_url` carries the parent's repo, and a number alone collides
 * across repos: a local child of design-vault#17 is not a child of this
 * repo's #17. A parent in another repo is therefore null, never a local
 * number. The converse — a local issue's children filed elsewhere — is
 * visible only on its own `/sub_issues`, never on this repo's issue list.
 *
 * Residual: a row missing `repository_url` counts its parent as this repo's,
 * as check-issue-cycles.js does. GitHub's REST issue rows always carry it.
 */

const { ghApiSlurp } = require("./gh");

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
 * Every sub-issue of local `n`, closed ones and other repos' included, across
 * every page — the endpoint defaults to 30. Throws as lib/gh.js does.
 * @param {number} n
 * @returns {any[]}
 */
const readSubIssues = (n) =>
	ghApiSlurp([`repos/{owner}/{repo}/issues/${n}/sub_issues`]);

/** @param {SubIssue} k */
const isOpenChild = (k) => k.state === "open" && !k.pull_request;

module.exports = { localParentOf, readSubIssues, isOpenChild };
