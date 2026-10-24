/*
 * blocker-graph.js — the open blocked-by graph the shortlist ranks on,
 * followed out of the served repo into any repo it reaches (workflow-core#2427).
 *
 * Every node is keyed `owner/name#n` (refKey), so a blocker in another repo
 * never credits the served issue that shares its number. From each open
 * served issue the walk follows open native edges and `**Blocked on**`
 * markers into any repo, then those blockers' own, to any depth; the node map
 * is the visited set that ends a cycle. A node outside the served repo costs
 * one blocked_by read, plus one issue read where a marker alone names it.
 *
 * Callers: scripts/pick-next.js, which ranks on reachOf and reports
 * pulledInOf's rows, and through its `--json` lib/refill-frontier.js.
 */

const { isInOtherRepo, refKey, refLabel } = require("./parent-claims.js");
const { proseRefsOf } = require("./prose-blockers.js");

/** @typedef {import("./parent-claims.js").IssueRef} IssueRef */
/**
 * An issue as a blocked_by or issue read gives it, `repo` resolved.
 * @typedef {IssueRef & {state: string, title: string, url: string, labels: string[], body: string}} Edge
 */
/** @typedef {{ok: true, edges: Edge[]} | {ok: false, error: string}} EdgesRead */
/** @typedef {{ok: true, issue: Edge} | {ok: false, error: string}} IssueRead */
/**
 * @typedef {object} Reads
 * @property {(ref: IssueRef) => Promise<EdgesRead>} blockedBy a foreign
 *   node's edges, each edge's `repo` resolved against `ref.repo`
 * @property {(ref: IssueRef) => Promise<IssueRead>} issue
 * @property {<T, R>(items: T[], fn: (item: T) => Promise<R>) => Promise<R[]>} each
 *   bounded fan-out, results in input order
 */
/**
 * @typedef {object} Node
 * @property {IssueRef} ref
 * @property {boolean} served
 * @property {Edge|null} info null on a served node, which its caller holds
 * @property {{key: string, ref: IssueRef, prose: boolean}[]} blockers open ones
 * @property {string|null} unknown why its blockers could not be read
 */

/**
 * `ref` with its repo filled in, `home` where it names none.
 * @param {IssueRef} ref
 * @param {string|null} home
 * @returns {IssueRef}
 */
const inRepo = (ref, home) => ({
	repo: ref.repo ?? home,
	number: ref.number,
});

/**
 * The graph over `served`'s open issues and every open blocker they reach.
 * @param {{number: number, edges: Edge[], body: string}[]} served
 *   every open issue in the served repo, its native edges resolved
 * @param {string|null} ownRepo
 * @param {Reads} read
 */
async function blockerGraph(served, ownRepo, read) {
	const openServed = new Set(served.map((s) => s.number));
	/** @param {IssueRef} ref */
	const isServed = (ref) => !isInOtherRepo(ref, ownRepo);
	/** @type {Map<string, Edge>} what a read has said of a foreign issue */
	const known = new Map();
	/** @type {Map<string, Promise<IssueRead>>} */
	const issueReads = new Map();
	/**
	 * @param {IssueRef} ref
	 * @returns {Promise<IssueRead>}
	 */
	const issueOf = async (ref) => {
		const k = refKey(ref);
		const seen = known.get(k);
		if (seen) return { ok: true, issue: seen };
		const pending = issueReads.get(k) ?? read.issue(ref);
		issueReads.set(k, pending);
		const r = await pending;
		if (r.ok) known.set(k, r.issue);
		return r;
	};

	/**
	 * A node's open blockers, native edges first, then markers no edge names.
	 * An unreadable marker reference holds as open: launching past a blocker
	 * is the one error the shortlist cannot take back.
	 * @param {IssueRef} ref
	 * @param {Edge[]} edges
	 * @param {string} body
	 */
	const blockersOf = async (ref, edges, body) => {
		/** @type {Node["blockers"]} */
		const out = [];
		const named = new Set();
		for (const e of edges) {
			const b = inRepo(e, ref.repo);
			const k = refKey(b);
			named.add(k);
			if (!isServed(b)) known.set(k, { ...e, ...b });
			if (e.state === "open") out.push({ key: k, ref: b, prose: false });
		}
		const prose = proseRefsOf(body)
			.map((r) => inRepo(r, ref.repo))
			.filter((r) => !named.has(refKey(r)));
		const open = await read.each(prose, async (r) => {
			if (isServed(r)) return openServed.has(r.number);
			const s = await issueOf(r);
			return !s.ok || s.issue.state === "open";
		});
		prose.forEach((r, idx) => {
			if (open[idx]) out.push({ key: refKey(r), ref: r, prose: true });
		});
		return out;
	};

	/** @type {Map<string, Node>} */
	const nodes = new Map();
	const servedNodes = await read.each(served, async (s) => {
		const ref = { repo: ownRepo, number: s.number };
		return {
			ref,
			served: true,
			info: null,
			blockers: await blockersOf(ref, s.edges, s.body),
			unknown: null,
		};
	});
	for (const n of servedNodes) nodes.set(refKey(n.ref), n);

	/** @param {Node[]} from */
	const unvisited = (from) => {
		/** @type {Map<string, IssueRef>} */
		const next = new Map();
		for (const n of from)
			for (const b of n.blockers)
				if (!isServed(b.ref) && !nodes.has(b.key)) next.set(b.key, b.ref);
		return [...next.values()];
	};
	let layer = unvisited(servedNodes);
	while (layer.length > 0) {
		const walked = await read.each(layer, async (ref) => {
			const s = await issueOf(ref);
			/** @type {Node} */
			const node = {
				ref,
				served: false,
				info: s.ok ? s.issue : null,
				blockers: [],
				unknown: s.ok ? null : s.error,
			};
			if (!s.ok) return node;
			const d = await read.blockedBy(ref);
			if (!d.ok) return { ...node, unknown: d.error };
			return {
				...node,
				blockers: await blockersOf(ref, d.edges, s.issue.body),
			};
		});
		for (const n of walked) nodes.set(refKey(n.ref), n);
		layer = unvisited(walked);
	}

	/** @type {Map<string, string[]>} blocker key -> the open nodes it blocks */
	const blocking = new Map([...nodes.keys()].map((k) => [k, []]));
	for (const [k, n] of nodes)
		for (const b of n.blockers) blocking.get(b.key)?.push(k);
	return { nodes, blocking, ownRepo };
}

/** @typedef {Awaited<ReturnType<typeof blockerGraph>>} Graph */

/**
 * The served issues `key` transitively holds out, sorted: what its reach
 * counts. A foreign node on the way passes the walk on but is not counted.
 * @param {Graph} graph
 * @param {string} key
 */
function heldBy(graph, key) {
	/** @type {Set<string>} */
	const seen = new Set();
	const stack = [...(graph.blocking.get(key) ?? [])];
	for (let k = stack.pop(); k !== undefined; k = stack.pop()) {
		if (seen.has(k)) continue;
		seen.add(k);
		for (const next of graph.blocking.get(k) ?? [])
			if (!seen.has(next)) stack.push(next);
	}
	return [...seen]
		.flatMap((k) => {
			const n = graph.nodes.get(k);
			return n?.served ? [n.ref.number] : [];
		})
		.sort((a, b) => a - b);
}

/**
 * Transitive downstream reach over open served descendants (mantahostels#101).
 * Direct out-degree is degenerate on this tracker — max 2 — so an
 * untransitive count would rank almost everything equal.
 * @param {Graph} graph
 * @param {number} n a served issue
 */
const reachOf = (graph, n) =>
	heldBy(graph, refKey({ repo: graph.ownRepo, number: n })).length;

/**
 * A served issue's open blockers as a reader sees them, its own repo's by
 * number, then `owner/name#n` for those in another; `native` is false for a
 * marker-only one.
 * @param {Graph} graph
 * @param {number} n
 * @returns {{label: string, native: boolean}[]}
 */
function openBlockersOf(graph, n) {
	const node = graph.nodes.get(refKey({ repo: graph.ownRepo, number: n }));
	const blockers = node?.blockers ?? [];
	const own = blockers
		.filter((b) => !isInOtherRepo(b.ref, graph.ownRepo))
		.sort((a, b) => a.ref.number - b.ref.number);
	const foreign = blockers
		.filter((b) => isInOtherRepo(b.ref, graph.ownRepo))
		.sort((a, b) => a.key.localeCompare(b.key));
	return [...own, ...foreign].map((b) => ({
		label: refLabel(b.ref, graph.ownRepo),
		native: !b.prose,
	}));
}

/**
 * Every open issue in another repo that holds a served issue out and that
 * nothing open holds itself: a launch candidate for its own repo (workflow-core#2427).
 * `unread` lists the foreign nodes whose blockers would not read. Each names
 * the served issues it holds as `owner/name#n`.
 * @param {Graph} graph
 */
function pulledInOf(graph) {
	const rows = [];
	const unread = [];
	/** @param {string} k */
	const holdsOf = (k) =>
		heldBy(graph, k).map((number) =>
			refLabel({ repo: graph.ownRepo, number }, null),
		);
	for (const [k, n] of graph.nodes) {
		if (n.served) continue;
		const holds = holdsOf(k);
		if (n.unknown) {
			unread.push({ ref: refLabel(n.ref, null), error: n.unknown, holds });
			continue;
		}
		if (n.blockers.length > 0 || n.info?.state !== "open") continue;
		rows.push({
			repo: n.ref.repo ?? "",
			number: n.ref.number,
			title: n.info.title,
			url: n.info.url,
			labels: n.info.labels,
			reach: holds.length,
			holds,
		});
	}
	rows.sort(
		(a, b) =>
			b.reach - a.reach || a.repo.localeCompare(b.repo) || a.number - b.number,
	);
	return { rows, unread };
}

module.exports = {
	blockerGraph,
	openBlockersOf,
	pulledInOf,
	reachOf,
};
