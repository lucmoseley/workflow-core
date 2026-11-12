/*
 * link-batch.js — many issues' native links in a few GraphQL calls (#2685,
 * #5097). One query shape reads each issue's state, its blockers and its
 * sub-issues.
 *
 * It reads the canonical `blockedBy` and `subIssues` connections, never
 * `issue_dependencies_summary` (mantahostels#105's staleness trap).
 *
 * FAILURE IS PER BATCH, OR PER ISSUE — NEVER "NO LINKS". A batch whose
 * response carries no `repository`, after one retry, fails every issue in it.
 * A connection a caller wants that GraphQL answers null, malformed or longer
 * than its page takes the REST read for that issue alone; that read failing
 * fails the issue.
 */

const {
	ghAsync,
	ghGetRetrying,
	retryingOnce,
	mapLimit,
	ISSUE_READ_CONCURRENCY,
} = require("./gh");
const { caught } = require("./caught.js");
const { parseRepoOfUrl } = require("./issue-ref.js");

/*
 * Node budget, per GitHub's count of each connection's `first:` times its
 * parent's: BATCH x (BLOCKERS x (1 + LABELS) + CHILDREN), under GitHub's
 * 500,000 cap. BLOCKERS at 50 would put it at 515,000, refused.
 */
const BATCH = 100;
/* Blockers read inline per issue, each with its title, body and labels.
 * Residual (#5097): one query serves both callers, so lib/wait-graph.js
 * reads fields it drops, and a node with over 25 blockers takes the REST
 * read. */
const BLOCKERS = 25;
/* Sub-issues read inline per issue, GitHub's page maximum. */
const CHILDREN = 100;
/* An issue carries at most 100 labels, so this connection never truncates. */
const LABELS = 100;

/** @typedef {"blockedBy" | "subIssues"} Connection */
/**
 * One link's target, from GraphQL or REST alike. `repo` is null where the
 * answer named none; a sub-issue's title, url and body are "" and its labels
 * empty, the query reading none of them.
 * @typedef {{repo: string|null, number: number, state: string, title: string,
 *   url: string, body: string, labels: string[]}} LinkRow
 */
/**
 * `self` is the queried repository's own `nameWithOwner`; `state` is null
 * where GraphQL answered the issue null and REST read its links.
 * @typedef {{ok: true, self: string, state: "open"|"closed"|null,
 *   links: Partial<Record<Connection, LinkRow[]>>}
 *   | {ok: false, error: string, reason: "unreachable"|"broken"}} LinksRead
 */
/**
 * GitHub's JSON as parsed, its shape the query's or the endpoint's and never
 * checked field by field: every reader below defaults each optional one.
 * @typedef {any} GhJson
 */

/** @type {Record<Connection, string>} */
const REST_TAIL = {
	blockedBy: "dependencies/blocked_by",
	subIssues: "sub_issues",
};

/** @param {number[]} numbers */
const buildQuery = (numbers) =>
	"query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { nameWithOwner " +
	numbers
		.map(
			(n) =>
				`i${n}: issue(number: ${n}) { state blockedBy(first: ${BLOCKERS}) { totalCount nodes { number state title url body repository { nameWithOwner } labels(first: ${LABELS}) { nodes { name } } } } subIssues(first: ${CHILDREN}) { totalCount nodes { number state repository { nameWithOwner } } } }`,
		)
		.join(" ") +
	" } }";

/**
 * A REST issue row as a LinkRow.
 * @param {GhJson} i
 * @returns {LinkRow}
 */
const restRow = (i) => ({
	repo: parseRepoOfUrl(i.repository_url),
	number: i.number,
	state: i.state,
	title: i.title ?? "",
	url: i.html_url ?? "",
	labels: (i.labels || []).map((/** @type {GhJson} */ l) =>
		l.name ? l.name : l,
	),
	body: i.body || "",
});

/**
 * A GraphQL link node as a LinkRow.
 * @param {GhJson} n
 * @returns {LinkRow}
 */
const nodeRow = (n) => ({
	repo: n.repository?.nameWithOwner ?? null,
	number: n.number,
	state: String(n.state).toLowerCase(),
	title: n.title ?? "",
	url: n.url ?? "",
	labels: (n.labels?.nodes ?? []).map((/** @type {GhJson} */ l) => l.name),
	body: n.body || "",
});

/**
 * A connection's rows, or null where it is missing, malformed or truncated.
 * @param {GhJson} conn
 * @returns {LinkRow[]|null}
 */
function rowsOf(conn) {
	if (!conn || typeof conn.totalCount !== "number") return null;
	if (
		!Array.isArray(conn.nodes) ||
		conn.nodes.some((/** @type {GhJson} */ n) => !n)
	)
		return null;
	return conn.totalCount > conn.nodes.length ? null : conn.nodes.map(nodeRow);
}

/**
 * `part` as a gh field: `-F` expands the `{owner}`/`{repo}` placeholders, and
 * types a bare `2048` or `true` as no String, so a real name goes by `-f`.
 * @param {string} key
 * @param {string} part
 */
const fieldArgs = (key, part) => [
	/^\{(owner|repo)\}$/.test(part) ? "-F" : "-f",
	`${key}=${part}`,
];

/**
 * The `repository` object in gh's printed answer, or null.
 * @param {string} out
 * @returns {GhJson}
 */
function repositoryIn(out) {
	try {
		const repository = JSON.parse(out)?.data?.repository;
		return repository?.nameWithOwner ? repository : null;
	} catch {
		return null;
	}
}

/**
 * One batched query's `repository` object. gh exits 1 on a partly errored
 * response yet prints the data, which still answers every issue it holds; any
 * other failure keeps gh's own error, whose stderr says whether GitHub was
 * reachable.
 * @param {string} repo `owner/name` or `{owner}/{repo}`
 * @param {number[]} numbers
 */
function readRepositoryBatch(repo, numbers) {
	const [owner = "", name = ""] = repo.split("/");
	const args = [
		"api",
		"graphql",
		...fieldArgs("owner", owner),
		...fieldArgs("name", name),
		"-f",
		`query=${buildQuery(numbers)}`,
	];
	return retryingOnce(async () => {
		/** @type {string} */
		let out;
		try {
			out = await ghAsync(args);
		} catch (e) {
			const rescued = repositoryIn(caught(e).stdout ?? "");
			if (rescued) return rescued;
			throw e;
		}
		if (!out.trim()) throw new Error("gh exited 0 having printed nothing");
		const repository = repositoryIn(out);
		if (!repository) throw new Error("gh's GraphQL answer named no repository");
		return repository;
	});
}

/**
 * One issue's links of one kind through REST, followed to its last page.
 * @param {string} repo
 * @param {number} n
 * @param {Connection} connection
 * @param {{strict?: boolean}} [opts] `strict` refuses an empty answer
 *   (lib/gh.js)
 * @returns {Promise<{ok: true, rows: LinkRow[]} | {ok: false, error: string, reason: "unreachable"|"broken"}>}
 */
async function readRestLinks(repo, n, connection, { strict = false } = {}) {
	const r = await ghGetRetrying(
		`repos/${repo}/issues/${n}/${REST_TAIL[connection]}`,
		{ strict },
	);
	return r.ok ? { ok: true, rows: r.out.map(restRow) } : r;
}

/**
 * One issue's alias completed: each wanted connection GraphQL left out read
 * through REST.
 * @param {string} repo
 * @param {{item: {number: number}, alias: GhJson, self: string}} answered
 * @param {{want: Connection[], strict: boolean}} opts
 * @returns {Promise<LinksRead>}
 */
async function completeRead(repo, { item, alias, self }, { want, strict }) {
	const n = item.number;
	/** @type {Partial<Record<Connection, LinkRow[]>>} */
	const links = {};
	for (const connection of want) {
		const inline = rowsOf(alias?.[connection]);
		if (inline) {
			links[connection] = inline;
			continue;
		}
		const r = await readRestLinks(repo, n, connection, { strict });
		if (!r.ok) return r;
		links[connection] = r.rows;
	}
	const state = alias?.state
		? /** @type {"open"|"closed"} */ (String(alias.state).toLowerCase())
		: null;
	return { ok: true, self, state, links };
}

/**
 * Each of `items`' links of the kinds `want` names, paired with it in input
 * order.
 * @template {{number: number}} T
 * @param {string} repo `owner/name` or `{owner}/{repo}`
 * @param {T[]} items issues in `repo`
 * @param {{want: Connection[], strict?: boolean}} opts
 * @returns {Promise<{item: T, read: LinksRead}[]>}
 */
async function readLinksMany(repo, items, { want, strict = false }) {
	/** @type {({item: T, read: LinksRead} | {item: T, alias: GhJson, self: string})[]} */
	const batched = [];
	for (let at = 0; at < items.length; at += BATCH) {
		const batch = items.slice(at, at + BATCH);
		const r = await readRepositoryBatch(
			repo,
			batch.map((i) => i.number),
		);
		for (const item of batch)
			batched.push(
				r.ok
					? { item, alias: r.out[`i${item.number}`], self: r.out.nameWithOwner }
					: { item, read: r },
			);
	}
	return mapLimit(batched, ISSUE_READ_CONCURRENCY, async (b) =>
		"read" in b
			? b
			: {
					item: b.item,
					read: await completeRead(repo, b, { want, strict }),
				},
	);
}

module.exports = { readLinksMany, readRestLinks, restRow };
