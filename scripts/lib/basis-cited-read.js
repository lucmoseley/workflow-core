/*
 * basis-cited-read.js — the issues a `**Gate basis:**` cites, read whole in one
 * batched GraphQL call (#5007): each one's state, body and every comment, so
 * lib/issue-gate.js can follow the citation one hop.
 *
 * FAILURE IS THE WHOLE READ, OR ONE REPOSITORY'S — NEVER "NO BASIS". A call
 * that fails, or a repository the answer holds no node for, leaves its
 * issues unread, which the gate library judges on their form alone. Only a
 * number a readable repository holds no issue under reads as no issue.
 */

const { gh } = require("./gh.js");
const { caught } = require("./caught.js");
const { citedKey } = require("./issue-gate.js");

/* Comments read per page, GitHub's own ceiling for one connection. */
const COMMENTS_PAGE = 100;
/* A name GraphQL takes as a literal string; anything else is never sent. */
const REPO_PART_RE = /^[\w.-]+$/;

/**
 * @typedef {import("./issue-gate.js").CitedIssue} CitedIssue
 * @typedef {{repo: string, number: number}} Wanted
 * @typedef {any} GhJson GitHub's answer as parsed, every reader defaulting a
 *   missing field
 */

/** @param {string|null} after */
const commentsField = (after) =>
	`comments(first: ${COMMENTS_PAGE}${after ? `, after: ${JSON.stringify(after)}` : ""}) { pageInfo { hasNextPage endCursor } nodes { body } }`;

/**
 * One GraphQL document reading `pages`, aliased by index so any repo
 * spelling is a legal alias. The first page carries state and body too.
 *
 * @param {string[]} repos `owner/name`, in alias order
 * @param {{repo: string, number: number, after: string|null}[]} pages
 */
function buildQuery(repos, pages) {
	const fields = repos.map((repo, r) => {
		const [owner, name] = repo.split("/");
		const issues = pages
			.filter((p) => p.repo === repo)
			.map(
				(p) =>
					`n${p.number}: issueOrPullRequest(number: ${p.number}) { __typename ... on Issue { ${p.after ? "" : "state body "}${commentsField(p.after)} } }`,
			);
		return `r${r}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${issues.join(" ")} }`;
	});
	return `query { ${fields.join(" ")} }`;
}

/**
 * Why a gh call failed, never from `err.message`, which repeats the whole
 * query.
 *
 * @param {import("./caught.js").Caught} err
 * @param {number} timeoutMs
 */
function failedWhy(err, timeoutMs) {
	if (err.code === "ETIMEDOUT")
		return `GitHub did not answer within ${timeoutMs} ms`;
	const stderr = (err.stderr ?? "").trim().split("\n").at(-1);
	const status = err.status == null ? null : `exit ${err.status}`;
	return `the GitHub read failed (${stderr || status || err.code || "no exit status"})`;
}

/**
 * The answer's `data`. gh exits non-zero on a partly errored answer, a
 * missing number among them, yet prints the data, which is read first.
 *
 * @param {string} query
 * @param {number} timeoutMs
 * @returns {{data: GhJson}|{why: string}}
 */
function runQuery(query, timeoutMs) {
	try {
		const data = JSON.parse(
			gh(["api", "graphql", "-f", `query=${query}`], { timeout: timeoutMs }),
		)?.data;
		return data && typeof data === "object"
			? { data }
			: { why: "GitHub's answer held no data" };
	} catch (e) {
		try {
			const data = JSON.parse(caught(e).stdout?.toString() ?? "")?.data;
			if (data && typeof data === "object") return { data };
		} catch {
			// Not JSON: no partial answer to read, so the failure stands.
		}
		return { why: failedWhy(caught(e), timeoutMs) };
	}
}

/**
 * @typedef {{repo: string, number: number, after: string|null}} Page one
 *   issue's next page of comments, its first carrying state and body
 * @typedef {{issues: Map<string, CitedIssue|null>,
 *   building: Map<string, CitedIssue>}} Into the issues read so far, and
 *   those with comments still to read
 */

/**
 * One page's answer, taken into `into`: the issue's next page where its
 * comments run on, or why its repository went unread.
 *
 * @param {GhJson} data
 * @param {string[]} repos
 * @param {Page} p
 * @param {Into} into accumulator: `into.issues` gains the issue once its
 *   comments are all read, `into.building` holds it until then
 * @returns {{next?: Page, why?: string}}
 */
function takePage(data, repos, p, into) {
	const key = citedKey(p);
	const repoNode = data[`r${repos.indexOf(p.repo)}`];
	if (!repoNode) {
		into.building.delete(key);
		return { why: `${p.repo} could not be read` };
	}
	/** @type {GhJson} */
	const node = repoNode[`n${p.number}`];
	if (node?.__typename !== "Issue") {
		into.issues.set(key, null);
		return {};
	}
	const issue = into.building.get(key) ?? {
		state: String(node.state ?? "").toLowerCase(),
		texts: [String(node.body ?? "")],
	};
	const conn = node.comments ?? {};
	for (const c of conn.nodes ?? [])
		if (c) issue.texts.push(String(c.body ?? ""));
	if (conn.pageInfo?.hasNextPage && conn.pageInfo.endCursor) {
		into.building.set(key, issue);
		return { next: { ...p, after: String(conn.pageInfo.endCursor) } };
	}
	into.building.delete(key);
	into.issues.set(key, issue);
	return {};
}

/**
 * Each wanted issue's state, body and every comment, by `owner/name#N`
 * lower-cased: null for a number its readable repository holds no issue
 * under, absent where it was not read.
 *
 * @param {Wanted[]} wanted each issue once, its repo lower-cased
 * @param {{timeoutMs: number}} opts `timeoutMs` bounds the whole
 *   read, its comment pages included
 * @returns {{issues: Map<string, CitedIssue|null>, why: string|null, ms: number}}
 *   `why`: what left any issue unread
 */
function readCitedIssues(wanted, { timeoutMs }) {
	const startedAt = Date.now();
	const sendable = wanted.filter((w) =>
		w.repo.split("/").every((part) => REPO_PART_RE.test(part)),
	);
	/** @type {string|null} */
	let why =
		sendable.length < wanted.length
			? "a repository name was not readable"
			: null;
	/** @type {Into} */
	const into = { issues: new Map(), building: new Map() };
	/** @type {Page[]} */
	let pages = sendable.map((w) => ({
		repo: w.repo,
		number: w.number,
		after: null,
	}));
	while (pages.length > 0) {
		const left = timeoutMs - (Date.now() - startedAt);
		const repos = [...new Set(pages.map((p) => p.repo))];
		const read =
			left > 0
				? runQuery(buildQuery(repos, pages), left)
				: { why: `GitHub did not answer within ${timeoutMs} ms` };
		if ("why" in read) {
			why = read.why;
			break;
		}
		const taken = pages.map((p) => takePage(read.data, repos, p, into));
		why ??= taken.find((t) => t.why)?.why ?? null;
		pages = taken.flatMap((t) => (t.next ? [t.next] : []));
	}
	return { issues: into.issues, why, ms: Date.now() - startedAt };
}

/**
 * The issues a trace of followed bases cites, once each.
 *
 * @param {import("./issue-gate.js").FollowRecord[]} trace
 * @returns {(Wanted & {key: string, ref: string})[]}
 */
const wantedIn = (trace) => [
	...new Map(
		trace.flatMap((t) =>
			t.cited.map((c) => [
				c.key,
				{ repo: c.repo, number: c.number, key: c.key, ref: c.ref },
			]),
		),
	).values(),
];

/* Stands in for the tracker where none resolves, so the citations a body
 * makes are still found; a name never read. */
const NO_TRACKER = "unresolved/tracker";

/**
 * The tracker a bare `#N` names, or null where none resolves.
 *
 * @param {string|undefined} root the project whose config names it
 */
function readTracker(root) {
	try {
		const t = require("./workflow-core-config.js").resolveKey(
			"tracker",
			root ? { root } : {},
		);
		return typeof t === "string" && t.includes("/") ? t : null;
	} catch {
		// An unreadable config resolves no tracker, which the caller's note
		// names (#5007): the citations are judged on their form alone.
		return null;
	}
}

/**
 * Reads the issues the bases `collect` judges cite, in one batched call:
 * undefined where no basis's warrant is an issue reference.
 *
 * @param {(follow: import("./issue-gate.js").Follow) => void} collect runs
 *   the judgement over an empty read with the `follow` it is handed, whose
 *   trace gathers what the bases cite
 * @param {{root?: string, timeoutMs: number, minMs?: number}} opts
 *   below `minMs` nothing is read, the hook's time being too short
 * @returns {{follow: import("./issue-gate.js").Follow,
 *   unread: (Wanted & {key: string, ref: string})[], why: string|null,
 *   ms: number}|undefined} `follow` carries the issues read; `why`, what
 *   left any unread
 */
function readCitedFor(collect, { root, timeoutMs, minMs = 0 }) {
	const tracker = readTracker(root);
	/** @type {import("./issue-gate.js").FollowRecord[]} */
	const trace = [];
	collect({ tracker: tracker ?? NO_TRACKER, issues: new Map(), trace });
	if (trace.length === 0) return;
	const wanted = wantedIn(trace);
	/** @param {string|null} why */
	const unreadAll = (why) => ({ issues: new Map(), why, ms: 0 });
	let read;
	/* A basis citing only its own issue is judged with nothing to read. */
	if (wanted.length === 0) read = unreadAll(null);
	else if (!tracker)
		read = unreadAll("no tracker resolves from `.claude/workflow-core.json`");
	else if (timeoutMs < minMs)
		read = unreadAll("too little of the hook's time was left for it");
	else read = readCitedIssues(wanted, { timeoutMs });
	return {
		follow: { tracker: tracker ?? NO_TRACKER, issues: read.issues, trace: [] },
		unread: wanted.filter((w) => !read.issues.has(w.key)),
		why: read.why,
		ms: read.ms,
	};
}

/**
 * The note naming the citations left unread.
 *
 * @param {string} lead what went unread, ahead of why
 * @param {string[]} names the citations
 * @param {string|null} why
 */
const unreadNote = (lead, names, why) =>
	`${lead} (${why ?? "GitHub did not answer for them"}): ${names.join(", ")}, so a basis whose only warrant is one of them was judged on its form alone.`;

module.exports = { readCitedFor, unreadNote };
