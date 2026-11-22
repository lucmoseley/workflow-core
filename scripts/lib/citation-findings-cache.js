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
const { orFallback } = require("./caught.js");
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
 * @property {string} version
 * @property {(text: string) => Finding|null} body
 * @property {(text: string) => Finding|null} comment
 * @typedef {object} Deps
 * @property {string} file
 * @property {() => Promise<{issues: IssueRow[], comments: CommentRow[]}>} readAll
 * @property {(since: string) => {issues: IssueRow[], comments: CommentRow[]}} readSince
 * @property {(n: string) => IssueRow|null} probeIssue
 * @property {(id: string) => CommentRow|null} probeComment
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
	/** @param {string[]} fields */
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
			return row?.repository_url?.endsWith(`/repos/${repo}`) ? row : null;
		},
		probeComment: (id) => probe(`repos/${repo}/issues/comments/${id}`),
		warn: (text) => writeFd(2, `issue-citations: ${text}\n`),
	};
}

/**
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
	const c = orFallback(() => JSON.parse(read.data), undefined);
	if (
		typeof c?.stamp === "string" &&
		!Number.isNaN(Date.parse(c.stamp)) &&
		typeof c.fullStamp === "string" &&
		c.issues &&
		typeof c.issues === "object" &&
		!Array.isArray(c.issues)
	)
		return c.version === version ? c : null;
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
		deps.warn(`could not write the citation cache (${parseErrLine(e)}).`);
	}
}

/** @param {CommentRow} c */
function commentIssue(c) {
	const n = /\/issues\/(\d+)$/.exec(c.issue_url)?.[1];
	if (!n) throw new Error(`a comment row names no issue: ${c.issue_url}`);
	return n;
}

/**
 * @param {Record<string, Entry>} issues
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
 * @param {Record<string, Entry>} issues
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
 * @param {Deps} deps
 * @param {Scanner} scan
 */
async function scanAll(deps, scan) {
	const all = await deps.readAll();
	const rows = all.issues.filter((i) => !i.pull_request);
	/** @type {Record<string, Entry>} */
	const issues = {};
	for (const row of rows) rescanIssue(issues, row, scan);
	for (const c of all.comments)
		if (issues[commentIssue(c)]) rescanComment(issues, c, scan);
	return {
		issues,
		counts: { issues: rows.length, comments: all.comments.length },
	};
}

/**
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
 * @param {Deps} deps
 * @param {Record<string, Entry>} issues
 * @param {string} n
 * @param {Entry} entry
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
