const {
	ghAsync,
	ghGetRetrying,
	retryingOnce,
	mapLimit,
	ISSUE_READ_CONCURRENCY,
} = require("./gh");
const { caught } = require("./caught.js");
const { parseRepoOfUrl } = require("./issue-ref.js");

// guess, workflow-core#5097
const BATCH = 100;
// guess, workflow-core#5097
const BLOCKERS = 25;
// https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
const CHILDREN = 100;
// https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
const LABELS = 100;

/** @typedef {"blockedBy" | "subIssues"} Connection */
/**
 * @typedef {{repo: string|null, number: number, state: string, title: string,
 *   url: string, body: string, labels: string[]}} LinkRow
 */
/**
 * @typedef {{ok: true, self: string, state: "open"|"closed"|null,
 *   links: Partial<Record<Connection, LinkRow[]>>}
 *   | {ok: false, error: string, reason: "unreachable"|"broken"}} LinksRead
 */
/**
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
 * @param {string} key
 * @param {string} part
 */
const fieldArgs = (key, part) => [
	/^\{(owner|repo)\}$/.test(part) ? "-F" : "-f",
	`${key}=${part}`,
];

/**
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
 * @param {string} repo
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
 * @param {string} repo
 * @param {number} n
 * @param {Connection} connection
 * @param {{strict?: boolean}} [opts]
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
 * @template {{number: number}} T
 * @param {string} repo
 * @param {T[]} items
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
