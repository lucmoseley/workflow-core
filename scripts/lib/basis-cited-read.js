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

/* Comments read per page, GitHub's own ceiling for one connection. */
const COMMENTS_PAGE = 100;
/* A name GraphQL takes as a literal string; anything else is never sent. */
const REPO_PART_RE = /^[\w.-]+$/;

/**
 * @typedef {import("./issue-gate.js").CitedIssue} CitedIssue
 * @typedef {{repo: string, number: number}} Wanted
 * @typedef {(args: string[], opts: {timeout: number}) => string} Gh gh's
 *   stdout; throws as lib/gh.js's gh throws
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
 * The answer's `data`. gh exits non-zero on a partly errored answer, a
 * missing number among them, yet prints the data, which is read first.
 *
 * @param {string} query
 * @param {number} timeoutMs
 * @param {Gh} run
 * @returns {{data: GhJson}|{why: string}}
 */
function runQuery(query, timeoutMs, run) {
	try {
		const data = JSON.parse(
			run(["api", "graphql", "-f", `query=${query}`], { timeout: timeoutMs }),
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
		const err = caught(e);
		if (err.code === "ETIMEDOUT")
			return { why: `GitHub did not answer within ${timeoutMs} ms` };
		const stderr = (err.stderr ?? "").toString().trim().split("\n").at(-1);
		return { why: `the GitHub read failed (${stderr || err.message})` };
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
 * @param {Into} into
 * @returns {{next?: Page, why?: string}}
 */
function takePage(data, repos, p, into) {
	const key = `${p.repo}#${p.number}`;
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
 * @param {Wanted[]} wanted
 * @param {{timeoutMs: number, run?: Gh}} opts `timeoutMs` bounds the whole
 *   read, its comment pages included
 * @returns {{issues: Map<string, CitedIssue|null>, why: string|null, ms: number}}
 *   `why`: what left any issue unread
 */
function readCitedIssues(wanted, { timeoutMs, run = gh }) {
	const startedAt = Date.now();
	const unique = [
		...new Map(
			wanted.map((w) => [`${w.repo.toLowerCase()}#${w.number}`, w]),
		).values(),
	];
	const sendable = unique.filter((w) =>
		w.repo.split("/").every((part) => REPO_PART_RE.test(part)),
	);
	/** @type {string|null} */
	let why =
		sendable.length < unique.length
			? "a repository name was not readable"
			: null;
	/** @type {Into} */
	const into = { issues: new Map(), building: new Map() };
	/** @type {Page[]} */
	let pages = sendable.map((w) => ({
		repo: w.repo.toLowerCase(),
		number: w.number,
		after: null,
	}));
	while (pages.length > 0) {
		const left = timeoutMs - (Date.now() - startedAt);
		const repos = [...new Set(pages.map((p) => p.repo))];
		const read =
			left > 0
				? runQuery(buildQuery(repos, pages), left, run)
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
 * @returns {{repo: string, number: number, key: string, ref: string}[]}
 */
const wantedIn = (trace) => [
	...new Map(
		trace.flatMap((t) =>
			t.cited.map((c) => {
				const at = c.key.lastIndexOf("#");
				return [
					c.key,
					{
						repo: c.key.slice(0, at),
						number: Number(c.key.slice(at + 1)),
						key: c.key,
						ref: c.ref,
					},
				];
			}),
		),
	).values(),
];

module.exports = { readCitedIssues, wantedIn, COMMENTS_PAGE };
