/*
 * wait-graph.js — the graph of open issues waiting on each other, in any repo
 * (#5070). An issue waits on each open blocker and, as a parent, on each open
 * sub-issue: it cannot close before they do. A loop needing both kinds is
 * invisible to a read of either alone, so both are read together.
 *
 * Nodes are keyed `owner/name#n` (refKey), so another repo's #3864 is never
 * ours. Each node's open blockers and open sub-issues come from the canonical
 * `blockedBy` and `subIssues` connections in one batched GraphQL call per
 * repo, never `issue_dependencies_summary` (docs/agents/issue-tracker.md, "Two
 * dependency graphs"); a node GraphQL answers null, or with a connection
 * longer than INNER, takes the REST read for itself alone.
 *
 * Every read is per node: edges, or unread with lib/gh.js's reason class.
 * What an unread node means is the caller's policy — the loop checker fails
 * closed on it, a link command fails open (lib/link-writer.js).
 *
 * Two operations: pathTo, for whether a new link closes a loop, and loops,
 * for every loop reachable from a set of seeds.
 */

const { ghGetRetrying, mapLimit, ISSUE_READ_CONCURRENCY } = require("./gh");
const { readRepositoryBatch } = require("./blocked-by-batch.js");
const { parseRepoOfUrl, refKey, refLabel } = require("./issue-ref.js");

/* Issues aliased into one call: 100 x 2 x 100 nodes is 20,000, far under
 * GitHub's 500,000-node cap. */
const BATCH = 100;
/* Edges read inline per connection, GitHub's page maximum; one longer takes
 * the REST read. */
const INNER = 100;

/** @typedef {{repo: string, number: number}} Ref */
/** @typedef {"child" | "blocker"} Kind */
/** @typedef {{from: Ref, to: Ref, kind: Kind}} Link */
/**
 * `state` is null where only REST answered, which does not say it.
 * @typedef {{ok: true, state: "open"|"closed"|null, edges: {to: Ref, kind: Kind}[]}
 *   | {ok: false, error: string, reason: "unreachable"|"broken"}} NodeRead
 */
/** @typedef {{ref: Ref, error: string, reason: "unreachable"|"broken"}} Unread */
/** GitHub's JSON as parsed. @typedef {any} GhJson */

const EDGE_FIELDS =
	"totalCount nodes { number state repository { nameWithOwner } }";

/** @param {number[]} numbers */
const buildQuery = (numbers) =>
	"query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { nameWithOwner " +
	numbers
		.map(
			(n) =>
				`i${n}: issue(number: ${n}) { state blockedBy(first: ${INNER}) { ${EDGE_FIELDS} } subIssues(first: ${INNER}) { ${EDGE_FIELDS} } }`,
		)
		.join(" ") +
	" } }";

/**
 * A connection's open edges, or null where it is missing, malformed or
 * truncated.
 * @param {GhJson} conn
 * @param {Kind} kind
 * @param {string} self the queried repository's `nameWithOwner`
 * @returns {{to: Ref, kind: Kind}[] | null}
 */
function edgesOf(conn, kind, self) {
	if (!conn || typeof conn.totalCount !== "number") return null;
	if (
		!Array.isArray(conn.nodes) ||
		conn.nodes.some((/** @type {GhJson} */ n) => !n)
	)
		return null;
	if (conn.totalCount > conn.nodes.length) return null;
	return conn.nodes
		.filter(
			(/** @type {GhJson} */ n) => String(n.state).toLowerCase() === "open",
		)
		.map((/** @type {GhJson} */ n) => ({
			to: { repo: n.repository?.nameWithOwner ?? self, number: n.number },
			kind,
		}));
}

/**
 * One connection's open edges through REST, followed to its last page.
 * @param {Ref} ref
 * @param {Kind} kind
 * @returns {Promise<{ok: true, edges: {to: Ref, kind: Kind}[]} | {ok: false, error: string, reason: "unreachable"|"broken"}>}
 */
async function readRestEdges(ref, kind) {
	const tail = kind === "blocker" ? "dependencies/blocked_by" : "sub_issues";
	const r = await ghGetRetrying(
		`repos/${ref.repo}/issues/${ref.number}/${tail}`,
	);
	if (!r.ok) return r;
	return {
		ok: true,
		edges: r.out
			.filter((/** @type {GhJson} */ i) => i.state === "open")
			.map((/** @type {GhJson} */ i) => ({
				to: {
					repo: parseRepoOfUrl(i.repository_url) ?? ref.repo,
					number: i.number,
				},
				kind,
			})),
	};
}

/**
 * A node GraphQL could not answer in full: each connection it left out read
 * through REST.
 * @param {Ref} ref
 * @param {GhJson} alias
 * @param {string} self
 * @returns {Promise<NodeRead>}
 */
async function readNodeRest(ref, alias, self) {
	/** @type {{to: Ref, kind: Kind}[]} */
	const edges = [];
	for (const [kind, field] of /** @type {[Kind, string][]} */ ([
		["blocker", "blockedBy"],
		["child", "subIssues"],
	])) {
		const inline = edgesOf(alias?.[field], kind, self);
		const read = inline
			? { ok: true, edges: inline }
			: await readRestEdges(ref, kind);
		if (!read.ok) return /** @type {NodeRead} */ (read);
		edges.push(.../** @type {{edges: {to: Ref, kind: Kind}[]}} */ (read).edges);
	}
	const state = alias?.state
		? /** @type {"open"|"closed"} */ (String(alias.state).toLowerCase())
		: null;
	return { ok: true, state, edges };
}

/**
 * One repo's nodes, read in batches.
 * @param {string} repo
 * @param {Ref[]} refs
 * @returns {Promise<[string, NodeRead][]>}
 */
async function readRepoNodes(repo, refs) {
	/** @type {{ref: Ref, alias: GhJson, self: string, read: NodeRead|null}[]} */
	const pending = [];
	/** @type {[string, NodeRead][]} */
	const out = [];
	for (let at = 0; at < refs.length; at += BATCH) {
		const batch = refs.slice(at, at + BATCH);
		const r = await readRepositoryBatch(
			repo,
			buildQuery(batch.map((x) => x.number)),
		);
		for (const ref of batch) {
			if (!r.ok) {
				out.push([refKey(ref), r]);
				continue;
			}
			const self = r.out.nameWithOwner;
			const alias = r.out[`i${ref.number}`];
			const blockers = edgesOf(alias?.blockedBy, "blocker", self);
			const children = edgesOf(alias?.subIssues, "child", self);
			pending.push({
				ref,
				alias,
				self,
				read:
					blockers && children
						? {
								ok: true,
								state: /** @type {"open"|"closed"} */ (
									String(alias.state).toLowerCase()
								),
								edges: [...blockers, ...children],
							}
						: null,
			});
		}
	}
	const rest = await mapLimit(pending, ISSUE_READ_CONCURRENCY, async (p) => [
		refKey(p.ref),
		p.read ?? (await readNodeRest(p.ref, p.alias, p.self)),
	]);
	return [...out, .../** @type {[string, NodeRead][]} */ (rest)];
}

/**
 * Each of `refs`' outgoing edges, keyed by refKey.
 * @param {Ref[]} refs
 * @returns {Promise<Map<string, NodeRead>>}
 */
async function readNodes(refs) {
	/** @type {Map<string, Ref[]>} */
	const byRepo = new Map();
	for (const ref of refs) {
		const k = ref.repo.toLowerCase();
		byRepo.set(k, [...(byRepo.get(k) ?? []), ref]);
	}
	/** @type {Map<string, NodeRead>} */
	const reads = new Map();
	for (const group of byRepo.values()) {
		const first = /** @type {Ref} */ (group[0]);
		for (const [k, r] of await readRepoNodes(first.repo, group))
			reads.set(k, r);
	}
	return reads;
}

/**
 * The graph a walk has read: each node's ref and edges, and those it could
 * not read.
 * @typedef {{refs: Map<string, Ref>, edges: Map<string, {to: Ref, kind: Kind}[]>,
 *   states: Map<string, NodeRead & {ok: true}>, unread: Unread[]}} Graph
 */

/** @returns {Graph} */
const buildEmptyGraph = () => ({
	refs: new Map(),
	edges: new Map(),
	states: new Map(),
	unread: [],
});

/**
 * Reads `frontier` into `g`, returning the refs it reaches that `g` has not
 * yet seen.
 * @param {Graph} g accumulator: the frontier's reads added
 * @param {Ref[]} frontier
 * @param {(k: string) => boolean} seen
 * @returns {Promise<Ref[]>}
 */
async function readLevel(g, frontier, seen) {
	const reads = await readNodes(frontier);
	/** @type {Map<string, Ref>} */
	const next = new Map();
	for (const ref of frontier) {
		const k = refKey(ref);
		const r = /** @type {NodeRead} */ (reads.get(k));
		if (!r.ok) {
			g.unread.push({ ref, error: r.error, reason: r.reason });
			continue;
		}
		g.states.set(k, r);
		g.edges.set(k, r.edges);
		for (const e of r.edges) {
			const ek = refKey(e.to);
			if (!seen(ek) && !next.has(ek)) next.set(ek, e.to);
		}
	}
	return [...next.values()];
}

/**
 * The shortest path of existing links from `from` to `to`, or null, and the
 * nodes the walk could not read. A closed `from` waits on nothing a loop
 * could pass through, so it reaches nothing.
 * @param {Ref} from
 * @param {Ref} to
 * @returns {Promise<{path: Link[] | null, unread: Unread[]}>}
 */
async function pathTo(from, to) {
	const g = buildEmptyGraph();
	const target = refKey(to);
	/** @type {Map<string, {from: Ref, kind: Kind}>} */
	const via = new Map();
	g.refs.set(refKey(from), from);
	let frontier = [from];
	while (frontier.length > 0 && !via.has(target)) {
		await readLevel(g, frontier, (k) => g.refs.has(k));
		if (g.states.get(refKey(from))?.state === "closed") break;
		frontier = advance(g, frontier, via, target);
	}
	return {
		path: via.has(target) ? traceBack(g, via, from, target) : null,
		unread: g.unread,
	};
}

/**
 * The refs one breadth-first step past `level` reaches first, each one's
 * link in `via`; `target` is recorded and never stepped past.
 * @param {Graph} g accumulator: each reached ref recorded
 * @param {Ref[]} level
 * @param {Map<string, {from: Ref, kind: Kind}>} via accumulator: each reached
 *   ref's link in
 * @param {string} target
 */
function advance(g, level, via, target) {
	/** @type {Ref[]} */
	const next = [];
	for (const ref of level)
		for (const e of g.edges.get(refKey(ref)) ?? []) {
			const k = refKey(e.to);
			if (g.refs.has(k)) continue;
			g.refs.set(k, e.to);
			via.set(k, { from: ref, kind: e.kind });
			if (k !== target) next.push(e.to);
		}
	return next;
}

/**
 * The links `via` records from `from` to `target`, in order.
 * @param {Graph} g
 * @param {Map<string, {from: Ref, kind: Kind}>} via
 * @param {Ref} from
 * @param {string} target
 * @returns {Link[]}
 */
function traceBack(g, via, from, target) {
	/** @type {Link[]} */
	const path = [];
	for (let k = target; k !== refKey(from); ) {
		const step = /** @type {{from: Ref, kind: Kind}} */ (via.get(k));
		path.unshift({
			from: step.from,
			to: /** @type {Ref} */ (g.refs.get(k)),
			kind: step.kind,
		});
		k = refKey(step.from);
	}
	return path;
}

/**
 * @typedef {{
 *   index: Map<string, number>,
 *   low: Map<string, number>,
 *   onStack: Set<string>,
 *   stack: string[],
 *   out: string[][],
 *   counter: number,
 * }} TarjanState
 */

/**
 * @param {TarjanState} st accumulator: `v` indexed and pushed
 * @param {string} v
 */
function discover(st, v) {
	st.index.set(v, st.counter);
	st.low.set(v, st.counter++);
	st.stack.push(v);
	st.onStack.add(v);
}

/**
 * Pops the component rooted at `v`, keeping it when it has more than one
 * member.
 * @param {TarjanState} st accumulator: the component popped and kept in `out`
 * @param {string} v
 */
function popComponent(st, v) {
	/** @type {string[]} */
	const comp = [];
	let w;
	do {
		w = /** @type {string} */ (st.stack.pop());
		st.onStack.delete(w);
		comp.push(w);
	} while (w !== v);
	if (comp.length > 1) st.out.push(comp);
}

/**
 * Follows one edge out of `top`, descending into an unvisited target.
 * @param {TarjanState} st accumulator: advanced one edge
 * @param {{v: string, i: number}[]} work accumulator: an unvisited target
 *   pushed
 * @param {{v: string, i: number}} top accumulator: its edge cursor advanced
 * @param {string} w
 */
function followEdge(st, work, top, w) {
	top.i++;
	if (!st.index.has(w)) {
		discover(st, w);
		work.push({ v: w, i: 0 });
	} else if (st.onStack.has(w))
		st.low.set(
			top.v,
			Math.min(Number(st.low.get(top.v)), Number(st.index.get(w))),
		);
}

/**
 * Leaves `top` once its edges are spent: passes its low-link to its parent
 * and closes its component when it is a root.
 * @param {TarjanState} st accumulator: low-links updated
 * @param {{v: string, i: number}[]} work accumulator: `top` popped
 * @param {{v: string, i: number}} top
 */
function finishNode(st, work, top) {
	work.pop();
	const parent = work.at(-1);
	if (parent)
		st.low.set(
			parent.v,
			Math.min(Number(st.low.get(parent.v)), Number(st.low.get(top.v))),
		);
	if (st.low.get(top.v) === st.index.get(top.v)) popComponent(st, top.v);
}

/**
 * Tarjan's strongly connected components, iteratively; components of one
 * member dropped (an issue cannot wait on itself through these endpoints).
 * @param {string[]} nodes
 * @param {Map<string, string[]>} next each node's targets
 * @returns {string[][]}
 */
function components(nodes, next) {
	/** @type {TarjanState} */
	const st = {
		index: new Map(),
		low: new Map(),
		onStack: new Set(),
		stack: [],
		out: [],
		counter: 0,
	};
	for (const root of nodes) {
		if (st.index.has(root)) continue;
		/** @type {{v: string, i: number}[]} */
		const work = [{ v: root, i: 0 }];
		discover(st, root);
		for (let top = work.at(-1); top !== undefined; top = work.at(-1)) {
			const w = (next.get(top.v) ?? [])[top.i];
			if (w === undefined) finishNode(st, work, top);
			else followEdge(st, work, top, w);
		}
	}
	return st.out;
}

/**
 * Orders refs `home`'s first, then by repo, then by number.
 * @param {string|null} home
 * @returns {(a: Ref, b: Ref) => number}
 */
const byRef = (home) => (a, b) => {
	const rank = (/** @type {Ref} */ r) =>
		refLabel(r, home).startsWith("#") ? 0 : 1;
	return (
		rank(a) - rank(b) ||
		a.repo.toLowerCase().localeCompare(b.repo.toLowerCase()) ||
		a.number - b.number
	);
};

/**
 * The shortest path from the component's first member back to itself.
 * @param {string[]} members keys, first the start
 * @param {Graph} g
 * @returns {Link[]}
 */
function examplePath(members, g) {
	const inComp = new Set(members);
	const start = /** @type {string} */ (members[0]);
	/** @type {Map<string, {from: string, kind: Kind}>} */
	const via = new Map();
	const queue = [start];
	while (queue.length > 0) {
		const v = /** @type {string} */ (queue.shift());
		for (const e of g.edges.get(v) ?? []) {
			const k = refKey(e.to);
			if (!inComp.has(k) || via.has(k)) continue;
			via.set(k, { from: v, kind: e.kind });
			if (k === start) queue.length = 0;
			else queue.push(k);
		}
	}
	/** @type {Link[]} */
	const path = [];
	let at = start;
	do {
		const step = /** @type {{from: string, kind: Kind}} */ (via.get(at));
		path.unshift({
			from: /** @type {Ref} */ (g.refs.get(step.from)),
			to: /** @type {Ref} */ (g.refs.get(at)),
			kind: step.kind,
		});
		at = step.from;
	} while (at !== start);
	return path;
}

/**
 * Every loop among the nodes reachable from `seeds`, each once with its
 * members ordered by `home` and one example path, plus the nodes the walk
 * read and could not read.
 * @param {Ref[]} seeds
 * @param {{home: string|null}} opts `home` orders members, its own first
 * @returns {Promise<{cycles: {members: Ref[], path: Link[]}[], nodes: number, unread: Unread[]}>}
 */
async function loops(seeds, { home }) {
	const g = buildEmptyGraph();
	let frontier = [];
	for (const s of seeds) {
		const k = refKey(s);
		if (g.refs.has(k)) continue;
		g.refs.set(k, s);
		frontier.push(s);
	}
	while (frontier.length > 0) {
		frontier = await readLevel(g, frontier, (k) => g.refs.has(k));
		for (const ref of frontier) g.refs.set(refKey(ref), ref);
	}
	/** @type {Map<string, string[]>} */
	const next = new Map();
	for (const [k, es] of g.edges)
		next.set(
			k,
			es.map((e) => refKey(e.to)),
		);
	const order = byRef(home);
	const cycles = components([...g.refs.keys()], next)
		.map((comp) => {
			const members = comp
				.map((k) => /** @type {Ref} */ (g.refs.get(k)))
				.sort(order);
			return { members, path: examplePath(members.map(refKey), g) };
		})
		.sort((a, b) =>
			order(
				/** @type {Ref} */ (a.members[0]),
				/** @type {Ref} */ (b.members[0]),
			),
		);
	return { cycles, nodes: g.refs.size, unread: g.unread };
}

/**
 * A link as a reader sees it from `home`.
 * @param {Link} l
 * @param {string|null} home
 */
const linkText = (l, home) =>
	l.kind === "child"
		? `${refLabel(l.from, home)} waits on child ${refLabel(l.to, home)}`
		: `${refLabel(l.from, home)} is blocked by ${refLabel(l.to, home)}`;

module.exports = { pathTo, loops, linkText, readNodes };
