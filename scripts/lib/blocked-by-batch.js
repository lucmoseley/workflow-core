/*
 * blocked-by-batch.js — many issues' native blockers in a few GraphQL calls,
 * not one REST `dependencies/blocked_by` call each (#2685).
 *
 * It reads the canonical `blockedBy` connection, never
 * `issue_dependencies_summary` (mantahostels#105's staleness trap).
 *
 * FAILURE IS PER BATCH, OR PER ISSUE — NEVER "NO BLOCKERS". A batch whose
 * response carries no `repository`, after one retry, fails every issue in it.
 * An issue GraphQL answers with null, or with more blockers than INNER, gets
 * the REST read for itself alone.
 *
 * Callers: scripts/pick-next.js, scripts/wayfinder-frontier.js,
 * scripts/check-issue-cycles.js.
 */

const {
	ghAsync,
	ghGetRetrying,
	retryingOnce,
	mapLimit,
	ISSUE_READ_CONCURRENCY,
} = require("./gh");
const { caught } = require("./caught.js");
const { isInOtherRepo, repoOfUrl } = require("./parent-claims.js");

/*
 * Issues aliased into one call. A guess: GitHub's 500,000-node cap would take
 * ~197 at INNER and LABELS below, and 100 leaves room for a field added later.
 */
const BATCH = 100;
/*
 * Blockers read inline per issue; one with more takes the REST read.
 * 100 issues x 25 x 100 labels is ~253,000 nodes; at 50 it is 505,100, over
 * the cap and refused.
 */
const INNER = 25;
/* An issue carries at most 100 labels, so this connection never truncates. */
const LABELS = 100;

/** @typedef {import("./blocker-graph").Edge} Edge */
/** @typedef {import("./blocker-graph").EdgesRead} EdgesRead */
/**
 * GitHub's JSON as parsed, its shape the query's or the endpoint's and never
 * checked field by field: every reader below defaults a missing one.
 * @typedef {any} GhJson
 */

/**
 * A REST issue row as lib/blocker-graph.js reads it, a row naming no repo
 * read as `home`'s.
 * @param {GhJson} i
 * @param {string|null} home
 * @returns {Edge}
 */
const edgeOf = (i, home) => ({
	repo: repoOfUrl(i.repository_url) ?? home,
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
 * A GraphQL blocker node as an Edge. One in the queried repo is `home`'s, so
 * `{owner}/{repo}` and the name it resolves to never read as two repos.
 * @param {GhJson} n
 * @param {string} queried the repository's own `nameWithOwner`
 * @param {string|null} home
 * @returns {Edge}
 */
const nodeEdge = (n, queried, home) => {
	const repo = n.repository?.nameWithOwner ?? null;
	return {
		repo:
			repo && isInOtherRepo({ repo, number: n.number }, queried) ? repo : home,
		number: n.number,
		state: String(n.state).toLowerCase(),
		title: n.title ?? "",
		url: n.url ?? "",
		labels: (n.labels?.nodes ?? []).map((/** @type {GhJson} */ l) => l.name),
		body: n.body || "",
	};
};

/** @param {number[]} numbers */
const buildQuery = (numbers) =>
	"query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { nameWithOwner " +
	numbers
		.map(
			(n) =>
				`i${n}: issue(number: ${n}) { blockedBy(first: ${INNER}) { totalCount nodes { number state title url body repository { nameWithOwner } labels(first: ${LABELS}) { nodes { name } } } } }`,
		)
		.join(" ") +
	" } }";

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
 * One batch's `repository` object. gh exits 1 on a partly errored response
 * yet prints the data, which still answers every issue it holds; any other
 * failure keeps gh's own error, whose stderr says whether GitHub was reachable.
 * @param {string} repo `owner/name` or `{owner}/{repo}`
 * @param {number[]} numbers
 */
function batchRead(repo, numbers) {
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
 * An issue's blockers from its alias, or null where the alias is null,
 * truncated or malformed: that issue takes the REST read.
 * @param {GhJson} alias
 * @returns {GhJson[]|null}
 */
function nodesOf(alias) {
	const conn = alias?.blockedBy;
	if (!conn || typeof conn.totalCount !== "number") return null;
	if (
		!Array.isArray(conn.nodes) ||
		conn.nodes.some((/** @type {GhJson} */ b) => !b)
	)
		return null;
	return conn.totalCount > conn.nodes.length ? null : conn.nodes;
}

/**
 * One issue's native blockers through REST, each edge's `repo` resolved
 * against `home`, and one in `self` — `repo`'s own name where `repo` is the
 * placeholder — read as `home`'s, as nodeEdge reads it.
 * @param {string} repo
 * @param {number} n
 * @param {{home: string|null, self?: string, strict?: boolean}} opts
 * @returns {Promise<EdgesRead>}
 */
async function readBlockedByOne(repo, n, { home, self, strict = false }) {
	const r = await ghGetRetrying(
		`repos/${repo}/issues/${n}/dependencies/blocked_by`,
		{ strict },
	);
	if (!r.ok) return r;
	return {
		ok: true,
		edges: r.out.map((i) => {
			const e = edgeOf(i, home);
			return self && e.repo && !isInOtherRepo(e, self)
				? { ...e, repo: home }
				: e;
		}),
	};
}

/**
 * Each of `issues`' native blockers, paired with it in input order, every
 * edge's `repo` resolved: `home` for one in `repo` itself.
 * @template {{number: number}} T
 * @param {T[]} issues issues in `repo`
 * @param {{repo: string, home: string|null, strict?: boolean}} opts
 *   `strict` refuses a REST fallback that answers empty (lib/gh.js)
 * @returns {Promise<{issue: T, read: EdgesRead}[]>}
 */
async function blockedByMany(issues, { repo, home, strict = false }) {
	/** @type {{issue: T, read: EdgesRead|null}[]} */
	const batched = [];
	/** @type {string|undefined} */
	let self;
	for (let at = 0; at < issues.length; at += BATCH) {
		const batch = issues.slice(at, at + BATCH);
		const r = await batchRead(
			repo,
			batch.map((i) => i.number),
		);
		for (const issue of batch) {
			if (!r.ok) {
				batched.push({ issue, read: r });
				continue;
			}
			self = r.out.nameWithOwner;
			const nodes = nodesOf(r.out[`i${issue.number}`]);
			batched.push({
				issue,
				read: nodes && {
					ok: true,
					edges: nodes.map((b) => nodeEdge(b, r.out.nameWithOwner, home)),
				},
			});
		}
	}
	return mapLimit(batched, ISSUE_READ_CONCURRENCY, async ({ issue, read }) => ({
		issue,
		read:
			read ??
			(await readBlockedByOne(repo, issue.number, { home, self, strict })),
	}));
}

module.exports = { blockedByMany, readBlockedByOne, edgeOf };
