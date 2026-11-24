const { gh } = require("./gh.js");
const { caught, orFallback } = require("./caught.js");
const {
	citedKey,
	untouchedBases,
	wordedBasisFaults,
} = require("./issue-gate.js");

// GraphQL first must be 1-100: https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api#node-limit
const COMMENTS_PAGE = 100;
const REPO_PART_RE = /^[\w.-]+$/;

/**
 * @typedef {import("./issue-gate.js").CitedIssue} CitedIssue
 * @typedef {{repo: string, number: number}} Wanted
 * @typedef {import("./issue-gate.js").WordedFault} WordedFault
 * @typedef {import("./issue-gate.js").Follow} Follow
 * @typedef {import("./issue-gate.js").FollowRecord} FollowRecord
 * @typedef {import("./issue-gate.js").BasisWrite} BasisWrite
 * @typedef {(args: string[], opts: {timeout: number}) => string} GhRun
 * @typedef {Wanted & {key: string, ref: string}} Unread
 * @typedef {any} GhJson
 */

/** @param {string|null} after */
const commentsField = (after) =>
	`comments(first: ${COMMENTS_PAGE}${after ? `, after: ${JSON.stringify(after)}` : ""}) { pageInfo { hasNextPage endCursor } nodes { body } }`;

/**
 * @param {string[]} repos
 * @param {{repo: string, number: number, after: string|null}[]} pages
 */
function buildQuery(repos, pages) {
	const fields = repos.map((repo, r) => {
		const [owner, name] = repo.split("/");
		const issues = pages
			.filter((p) => p.repo === repo)
			.map(
				(p) =>
					`n${p.number}: issueOrPullRequest(number: ${p.number}) { __typename ... on Issue { ${p.after ? "" : "body "}${commentsField(p.after)} } }`,
			);
		return `r${r}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${issues.join(" ")} }`;
	});
	return `query { ${fields.join(" ")} }`;
}

/**
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
 * @param {string} query
 * @param {number} timeoutMs
 * @param {GhRun} run
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
		const data = orFallback(
			() => JSON.parse(caught(e).stdout?.toString() ?? "")?.data,
			undefined,
		);
		if (data && typeof data === "object") return { data };
		return { why: failedWhy(caught(e), timeoutMs) };
	}
}

/**
 * @typedef {{repo: string, number: number, after: string|null}} Page
 * @typedef {{issues: Map<string, CitedIssue|null>,
 *   building: Map<string, CitedIssue>}} Into
 */

/**
 * @param {GhJson} data
 * @param {string[]} repos
 * @param {Page} p
 * @param {Into} into
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
 * @param {Wanted[]} wanted
 * @param {{timeoutMs: number, run: GhRun}} opts
 * @returns {{issues: Map<string, CitedIssue|null>, why: string|null, ms: number}}
 */
function readCitedIssues(wanted, { timeoutMs, run }) {
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
 * @param {FollowRecord[]} trace
 * @returns {Unread[]}
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

const NO_TRACKER = "unresolved/tracker";

/** @param {string|undefined} root */
function readTracker(root) {
	try {
		const t = require("./workflow-core-config.js").resolveKey(
			"tracker",
			root ? { root } : {},
		);
		return typeof t === "string" && t.includes("/") ? t : null;
	} catch {
		return null;
	}
}

// guess, workflow-core#5007
const MIN_CITED_MS = 3000;
const CITED_BOUND_MS = 10_000;

/**
 * @param {BasisWrite[]} bodies
 * @param {{timeoutMs: number, root?: string, env?: NodeJS.ProcessEnv,
 *   gh?: GhRun}} opts
 * @returns {{faults: WordedFault[][], traces: FollowRecord[][],
 *   unread: Unread[], why: string|null, ms: number}}
 */
function readBasisFaults(
	bodies,
	{ timeoutMs, root, env = process.env, gh: run = gh },
) {
	const formOnly = (/** @type {Follow} */ follow) => ({
		faults: bodies.map((w) => faultsOf(w, follow)),
		traces: bodies.map(() => []),
		unread: [],
		why: null,
		ms: 0,
	});
	if (env.WFC_GATE_CITED === "off" && env.VITEST_WORKER_ID)
		return formOnly({ tracker: NO_TRACKER, issues: new Map() });
	const tracker = readTracker(root);
	/** @type {FollowRecord[]} */
	const trace = [];
	const collected = formOnly({
		tracker: tracker ?? NO_TRACKER,
		issues: new Map(),
		trace,
	});
	if (trace.length === 0) return collected;
	const wanted = wantedIn(trace);
	/** @param {string|null} why */
	const unreadAll = (why) => ({ issues: new Map(), why, ms: 0 });
	let read;
	if (wanted.length === 0) read = unreadAll(null);
	else if (!tracker)
		read = unreadAll("no tracker resolves from `.claude/workflow-core.json`");
	else if (timeoutMs < MIN_CITED_MS)
		read = unreadAll("too little of the hook's time was left for it");
	else read = readCitedIssues(wanted, { timeoutMs, run });
	/** @type {FollowRecord[][]} */
	const traces = bodies.map(() => []);
	return {
		faults: bodies.map((w, i) =>
			faultsOf(w, {
				tracker: tracker ?? NO_TRACKER,
				issues: read.issues,
				trace: traces[i],
			}),
		),
		traces,
		unread: wanted.filter((w) => !read.issues.has(w.key)),
		why: read.why,
		ms: read.ms,
	};
}

/**
 * @param {BasisWrite} write
 * @param {Follow} follow
 */
const faultsOf = ({ body, own, before }, follow) =>
	wordedBasisFaults(
		body,
		own,
		before === undefined
			? follow
			: { ...follow, skip: untouchedBases(before, String(body || "")) },
	);

/**
 * @param {string} lead
 * @param {string[]} names
 * @param {string|null} why
 */
const unreadNote = (lead, names, why) =>
	`${lead} (${why ?? "GitHub did not answer for them"}): ${names.join(", ")}, so a basis whose only warrant is one of them was judged on its form alone.`;

module.exports = { CITED_BOUND_MS, readBasisFaults, unreadNote };
