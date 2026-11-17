/*
 * citation-findings-cache.js — check-issue-citations.js's read of the tracker
 * (#5355): every surface once, then only what changed since the last run.
 *
 * One GraphQL walk of every body and comment timed out at GitHub's gateway
 * once the tracker passed ~5,300 issues (HTTP 502, then 504). The cold read is
 * REST instead, the issues list and the repo-wide comments list in parallel,
 * 100 rows a page, so no single request grows with the tracker. Every later
 * run reads only the issues and comments updated since the cache's stamp, and
 * carries every other surface's findings from the cache.
 *
 * ONLY FINDINGS ARE CACHED, per surface: an issue's body, or one comment by
 * its REST id. A surface that changed is rescanned whole; one that did not
 * cannot have changed its findings. Three changes reach no `since` read: a
 * deleted comment, a deleted issue and an issue transferred out. So every
 * cached finding the since read did not touch is probed by its own id each
 * run, and a 404, a 410 or a row from another repo drops it — a cost bounded
 * by the findings, not the tracker. Residual: an issue transferred IN keeps
 * its comments' old `updated_at`, so they go unscanned until the next cold
 * read.
 *
 * The cache carries the scanner's version, a hash of its source: a changed
 * rule rescans everything rather than reporting under the old one. A failed
 * read throws and leaves the cache as it was, so the next run re-reads the
 * same window.
 *
 * One file per tracker under the gitignored markers directory of the main
 * checkout, shared by every worktree, written by rename. Last writer wins:
 * every write is a whole cache.
 */

const path = require("node:path");
const {
	assertOpenRead,
	gh,
	ghApiSlurp,
	ghApiSlurpAsync,
	ghIssuesUpdatedSince,
	isGone,
	parseErrLine,
	SINCE_SKEW_MS,
} = require("./gh.js");
const { writeFileAtomic } = require("./atomic-write.js");
const { readText } = require("./file-read.js");
const { MARKERS_REL } = require("./marker-root.js");
const { hostRoot } = require("./host-root.js");
const { writeFd } = require("./write-fd.js");

/**
 * @typedef {ReturnType<typeof import("./title-first-links").titleFirstLinks>} Links
 * @typedef {{links: Links, lines?: string[]}} Finding
 * @typedef {{number: number, title: string, html_url: string, repository_url?: string, body?: string|null, pull_request?: object}} IssueRow
 * @typedef {{id: number, issue_url: string, body?: string|null}} CommentRow
 * @typedef {{title: string, url: string, body?: Finding, comments: Record<string, Finding>}} Entry
 * @typedef {{version: string, stamp: string, fullStamp: string, issues: Record<string, Entry>}} Cache
 * @typedef {object} Scanner
 * @property {string} version changes whenever what a scan finds could
 * @property {(text: string) => Finding|null} body a body's findings
 * @property {(text: string) => Finding|null} comment a comment's findings
 * @typedef {object} Deps
 * @property {string} file
 * @property {() => Promise<{issues: IssueRow[], comments: CommentRow[]}>} readAll
 * @property {(since: string) => {issues: IssueRow[], comments: CommentRow[]}} readSince
 * @property {(n: string) => IssueRow|null} probeIssue null where it is gone
 * @property {(id: string) => CommentRow|null} probeComment null where it is gone
 * @property {(text: string) => void} warn
 */

/** @param {string} repo */
function buildGhDeps(repo) {
	/** @param {string} apiPath */
	const probe = (apiPath) => {
		try {
			return JSON.parse(gh(["api", apiPath]));
		} catch (e) {
			if (isGone(e)) return null;
			throw e;
		}
	};
	/** `-f` query fields, 100 rows a page. @param {string[]} fields */
	const listQuery = (fields) => [
		"-X",
		"GET",
		...fields.flatMap((f) => ["-f", f]),
		"-f",
		"per_page=100",
	];
	const allIssues = () =>
		ghApiSlurpAsync([`repos/${repo}/issues`, ...listQuery(["state=all"])]);
	/** @type {Deps} */
	return {
		file: path.join(
			hostRoot(),
			MARKERS_REL,
			"issue-citations",
			`${repo.replace("/", "__")}.json`,
		),
		readAll: async () => {
			const [issues, comments] = await Promise.all([
				allIssues(),
				ghApiSlurpAsync([`repos/${repo}/issues/comments`, ...listQuery([])]),
			]);
			return {
				issues: assertOpenRead(
					issues.length > 0 ? issues : await allIssues(),
					repo,
				),
				comments,
			};
		},
		readSince: (since) => ({
			issues: ghIssuesUpdatedSince(repo, since),
			comments: ghApiSlurp([
				`repos/${repo}/issues/comments`,
				...listQuery([`since=${since}`]),
			]),
		}),
		probeIssue: (n) => {
			const row = probe(`repos/${repo}/issues/${n}`);
			// A transferred issue redirects to its new repo, which gh follows.
			return row?.repository_url?.endsWith(`/repos/${repo}`) ? row : null;
		},
		probeComment: (id) => probe(`repos/${repo}/issues/comments/${id}`),
		warn: (text) => writeFd(2, `issue-citations: ${text}\n`),
	};
}

/**
 * The cache at `deps.file`, or null where it is absent, unusable or from
 * another scanner version — saying so where a file is there but unusable.
 * @param {Deps} deps
 * @param {string} version
 * @returns {Cache|null}
 */
function readCache(deps, version) {
	const read = readText(deps.file);
	if (read.state === "absent") return null;
	if (read.state === "unreadable") {
		deps.warn(
			`the citation cache is unreadable (${read.message}) — reading the whole tracker.`,
		);
		return null;
	}
	try {
		const c = JSON.parse(read.data);
		if (
			typeof c?.stamp === "string" &&
			!Number.isNaN(Date.parse(c.stamp)) &&
			typeof c.fullStamp === "string" &&
			c.issues &&
			typeof c.issues === "object" &&
			!Array.isArray(c.issues)
		)
			return c.version === version ? c : null;
	} catch {
		// Falls through to the warning below.
	}
	deps.warn("the citation cache is unusable — reading the whole tracker.");
	return null;
}

/**
 * @param {Deps} deps
 * @param {Cache} cache
 */
function writeCache(deps, cache) {
	try {
		writeFileAtomic(deps.file, JSON.stringify(cache), { mkdir: true });
	} catch (e) {
		// The cache only saves time: the next run reads the whole tracker.
		deps.warn(`could not write the citation cache (${parseErrLine(e)}).`);
	}
}

/** The issue number a comment row sits on. @param {CommentRow} c */
function commentIssue(c) {
	const n = /\/issues\/(\d+)$/.exec(c.issue_url)?.[1];
	if (!n) throw new Error(`a comment row names no issue: ${c.issue_url}`);
	return n;
}

/**
 * @param {Record<string, Entry>} issues accumulator: the row's entry is set
 * @param {IssueRow} row
 * @param {Scanner} scan
 */
function rescanIssue(issues, row, scan) {
	/** @type {Entry} */
	const entry = issues[row.number] ?? { title: "", url: "", comments: {} };
	entry.title = row.title;
	entry.url = row.html_url;
	const found = scan.body(row.body ?? "");
	if (found) entry.body = found;
	else delete entry.body;
	issues[row.number] = entry;
}

/**
 * @param {Record<string, Entry>} issues accumulator: the comment's finding
 *   is set or dropped on its issue's entry
 * @param {CommentRow} row
 * @param {Scanner} scan
 */
function rescanComment(issues, row, scan) {
	const n = commentIssue(row);
	const found = scan.comment(row.body ?? "");
	const entry = issues[n];
	if (found) {
		const kept = entry ?? { title: "", url: "", comments: {} };
		kept.comments[row.id] = found;
		issues[n] = kept;
	} else if (entry) delete entry.comments[row.id];
}

/** @param {Entry} e */
const hasFinding = (e) => Boolean(e.body) || Object.keys(e.comments).length > 0;

/** @param {Record<string, Entry>} issues */
const prune = (issues) =>
	Object.fromEntries(Object.entries(issues).filter(([, e]) => hasFinding(e)));

/**
 * The whole tracker scanned: the cold read.
 * @param {Deps} deps
 * @param {Scanner} scan
 */
async function scanAll(deps, scan) {
	const all = await deps.readAll();
	const rows = all.issues.filter((i) => !i.pull_request);
	/** @type {Record<string, Entry>} */
	const issues = {};
	for (const row of rows) rescanIssue(issues, row, scan);
	// A comment on a pull request has no issue row to land on.
	for (const c of all.comments)
		if (issues[commentIssue(c)]) rescanComment(issues, c, scan);
	return {
		issues,
		counts: { issues: rows.length, comments: all.comments.length },
	};
}

/**
 * `cache`'s findings with every surface changed since its stamp rescanned,
 * and every other one probed for still existing.
 * @param {Deps} deps
 * @param {Scanner} scan
 * @param {Cache} cache
 * @param {string} since
 */
function scanSince(deps, scan, cache, since) {
	const changed = deps.readSince(since);
	const issues = structuredClone(cache.issues);
	const readIssues = new Set();
	for (const row of changed.issues) {
		rescanIssue(issues, row, scan);
		readIssues.add(String(row.number));
	}
	const readComments = new Set();
	for (const c of changed.comments) {
		rescanComment(issues, c, scan);
		readComments.add(String(c.id));
	}
	for (const [n, entry] of Object.entries(issues)) {
		for (const id of Object.keys(entry.comments))
			if (!readComments.has(id) && !deps.probeComment(id))
				delete entry.comments[id];
		if (!readIssues.has(n) && hasFinding(entry))
			refreshUnread(deps, issues, n, entry);
	}
	return {
		issues,
		counts: {
			issues: changed.issues.length,
			comments: changed.comments.length,
		},
	};
}

/**
 * An issue holding a finding the since read did not return — untouched, or
 * reached only through a comment: dropped where it is gone, transferred or a
 * pull request, else given its current title.
 * @param {Deps} deps
 * @param {Record<string, Entry>} issues accumulator: `n` is dropped from it
 *   where it is gone
 * @param {string} n
 * @param {Entry} entry `issues[n]`, retitled in place
 */
function refreshUnread(deps, issues, n, entry) {
	const row = deps.probeIssue(n);
	if (!row || row.pull_request) delete issues[n];
	else {
		entry.title = row.title;
		entry.url = row.html_url;
	}
}

/**
 * Every issue holding a finding, keyed by number, and what this run read.
 * Throws where a read fails; the cache is then left as it was.
 * @param {string} repo
 * @param {Scanner} scan
 * @returns {Promise<{issues: Record<string, Entry>, read: {full: boolean, issues: number, comments: number, since?: string, fullStamp: string}}>}
 */
async function readCitationFindings(repo, scan) {
	const deps = buildGhDeps(repo);
	const stamp = new Date().toISOString();
	const cache = readCache(deps, scan.version);
	const since =
		cache && new Date(Date.parse(cache.stamp) - SINCE_SKEW_MS).toISOString();
	const fullStamp = cache ? cache.fullStamp : stamp;
	const { issues, counts } =
		cache && since
			? scanSince(deps, scan, cache, since)
			: await scanAll(deps, scan);
	const kept = prune(issues);
	writeCache(deps, { version: scan.version, stamp, fullStamp, issues: kept });
	return {
		issues: kept,
		read: { full: !cache, ...counts, ...(since && { since }), fullStamp },
	};
}

module.exports = { readCitationFindings };
