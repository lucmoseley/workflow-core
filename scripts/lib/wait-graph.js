const { readLinksMany } = require("./link-batch.js");
const { refKey, refLabel } = require("./issue-ref.js");
const { gateRefsOf } = require("./issue-gate.js");

/** @typedef {{repo: string, number: number}} Ref */
/** @typedef {"child" | "blocker" | "gate"} Kind */
/** @typedef {{from: Ref, to: Ref, kind: Kind}} Link */
/**
 * @typedef {{ok: true, state: "open"|"closed"|null, edges: {to: Ref, kind: Kind}[]}
 *   | {ok: false, error: string, reason: "unreachable"|"broken"}} NodeRead
 */
/** @typedef {{ref: Ref, error: string, reason: "unreachable"|"broken"}} Unread */

/** @template T @param {T|undefined} v @returns {T} */
function must(v) {
	if (v === undefined)
		throw new Error("wait-graph: a node the walk recorded is missing");
	return v;
}

/**
 * @param {import("./link-batch").LinkRow[]} rows
 * @param {Kind} kind
 * @param {string} self
 * @returns {{to: Ref, kind: Kind}[]}
 */
const openEdges = (rows, kind, self) =>
	rows
		.filter((r) => r.state === "open")
		.map((r) => ({ to: { repo: r.repo ?? self, number: r.number }, kind }));

/**
 * @param {Ref} item
 * @param {import("./link-batch").LinksRead & {ok: true}} read
 * @returns {{to: Ref, kind: Kind}[]}
 */
function edgesOf(item, read) {
	if (read.state === "closed") return [];
	const own = refKey({ repo: read.self, number: item.number });
	return [
		...openEdges(read.links.blockedBy ?? [], "blocker", read.self),
		...openEdges(read.links.subIssues ?? [], "child", read.self),
		...gateRefsOf(read.body, read.self)
			.filter((to) => refKey(to) !== own)
			.map((to) => ({ to, kind: /** @type {Kind} */ ("gate") })),
	];
}

/**
 * @param {string} repo
 * @param {Ref[]} refs
 * @returns {Promise<[string, NodeRead][]>}
 */
async function readRepoNodes(repo, refs) {
	const reads = await readLinksMany(repo, refs, {
		want: ["blockedBy", "subIssues"],
	});
	return reads.map(({ item, read }) => [
		refKey(item),
		read.ok
			? { ok: true, state: read.state, edges: edgesOf(item, read) }
			: read,
	]);
}

/** @param {Ref[]} refs @returns {Promise<Map<string, NodeRead>>} */
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
		const first = must(group[0]);
		for (const [k, r] of await readRepoNodes(first.repo, group))
			reads.set(k, r);
	}
	return reads;
}

// #5698
/**
 * @typedef {{refs: Map<string, Ref>, edges: Map<string, {to: Ref, kind: Kind}[]>,
 *   states: Map<string, NodeRead & {ok: true}>, unread: Unread[], linked: Set<string>}} Graph
 */

/** @returns {Graph} */
const buildEmptyGraph = () => ({
	refs: new Map(),
	edges: new Map(),
	states: new Map(),
	unread: [],
	linked: new Set(),
});

/**
 * @param {Graph} g
 * @param {Ref} ref
 * @param {NodeRead} r
 * @returns {{to: Ref, kind: Kind}[]}
 */
function recordRead(g, ref, r) {
	const k = refKey(ref);
	if (!r.ok) {
		if (r.reason === "unreachable" || g.linked.has(k))
			g.unread.push({ ref, error: r.error, reason: r.reason });
		return [];
	}
	g.states.set(k, r);
	g.edges.set(k, r.edges);
	for (const e of r.edges) if (e.kind !== "gate") g.linked.add(refKey(e.to));
	return r.edges;
}

/**
 * @param {Graph} g
 * @param {Ref[]} frontier
 * @param {(k: string) => boolean} seen
 * @returns {Promise<Ref[]>}
 */
async function readLevel(g, frontier, seen) {
	const reads = await readNodes(frontier);
	/** @type {Map<string, Ref>} */
	const next = new Map();
	for (const ref of frontier)
		for (const e of recordRead(g, ref, must(reads.get(refKey(ref))))) {
			const ek = refKey(e.to);
			if (!seen(ek) && !next.has(ek)) next.set(ek, e.to);
		}
	return [...next.values()];
}

/**
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
	g.linked.add(refKey(from));
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
 * @param {Graph} g
 * @param {Ref[]} level
 * @param {Map<string, {from: Ref, kind: Kind}>} via
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
		const step = must(via.get(k));
		path.unshift({
			from: step.from,
			to: must(g.refs.get(k)),
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

/** @param {TarjanState} st @param {string} v */
function discover(st, v) {
	st.index.set(v, st.counter);
	st.low.set(v, st.counter++);
	st.stack.push(v);
	st.onStack.add(v);
}

/** @param {TarjanState} st @param {string} v */
function popComponent(st, v) {
	/** @type {string[]} */
	const comp = [];
	let w;
	do {
		w = must(st.stack.pop());
		st.onStack.delete(w);
		comp.push(w);
	} while (w !== v);
	if (comp.length > 1) st.out.push(comp);
}

/**
 * @param {TarjanState} st
 * @param {{v: string, i: number}[]} work
 * @param {{v: string, i: number}} top
 * @param {string} w
 */
function followEdge(st, work, top, w) {
	top.i++;
	if (!st.index.has(w)) {
		discover(st, w);
		work.push({ v: w, i: 0 });
	} else if (st.onStack.has(w))
		st.low.set(top.v, Math.min(must(st.low.get(top.v)), must(st.index.get(w))));
}

/**
 * @param {TarjanState} st
 * @param {{v: string, i: number}[]} work
 * @param {{v: string, i: number}} top
 */
function finishNode(st, work, top) {
	work.pop();
	const parent = work.at(-1);
	if (parent)
		st.low.set(
			parent.v,
			Math.min(must(st.low.get(parent.v)), must(st.low.get(top.v))),
		);
	if (st.low.get(top.v) === st.index.get(top.v)) popComponent(st, top.v);
}

/**
 * @param {string[]} nodes
 * @param {Map<string, string[]>} next
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

/** @param {string|null} home @returns {(a: Ref, b: Ref) => number} */
const byRef = (home) => (a, b) => {
	const rank = (/** @type {Ref} */ r) =>
		refLabel(r, home).startsWith("#") ? 0 : 1;
	return (
		rank(a) - rank(b) ||
		a.repo.toLowerCase().localeCompare(b.repo.toLowerCase()) ||
		a.number - b.number
	);
};

/** @param {string[]} members @param {Graph} g @returns {Link[]} */
function examplePath(members, g) {
	const inComp = new Set(members);
	const start = must(members[0]);
	/** @type {Map<string, {from: string, kind: Kind}>} */
	const via = new Map();
	const queue = [start];
	while (queue.length > 0) {
		const v = must(queue.shift());
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
		const step = must(via.get(at));
		path.unshift({
			from: must(g.refs.get(step.from)),
			to: must(g.refs.get(at)),
			kind: step.kind,
		});
		at = step.from;
	} while (at !== start);
	return path;
}

/**
 * @param {Ref[]} seeds
 * @param {{home: string|null}} opts
 * @returns {Promise<{cycles: {members: Ref[], path: Link[]}[], nodes: number, unread: Unread[]}>}
 */
async function loops(seeds, { home }) {
	const g = buildEmptyGraph();
	let frontier = [];
	for (const s of seeds) {
		const k = refKey(s);
		if (g.refs.has(k)) continue;
		g.refs.set(k, s);
		g.linked.add(k);
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
			es.map((e) => refKey(e.to)).filter((to) => g.edges.has(to)),
		);
	const order = byRef(home);
	const cycles = components([...g.refs.keys()], next)
		.map((comp) => {
			const members = comp.map((k) => must(g.refs.get(k))).sort(order);
			return { members, path: examplePath(members.map(refKey), g) };
		})
		.sort((a, b) => order(must(a.members[0]), must(b.members[0])));
	return { cycles, nodes: g.refs.size, unread: g.unread };
}

/** @type {Record<Kind, string>} */
const VERB = {
	child: "waits on child",
	blocker: "is blocked by",
	gate: "is gated on",
};

/** @param {Link} l @param {string|null} home */
const linkText = (l, home) =>
	`${refLabel(l.from, home)} ${VERB[l.kind]} ${refLabel(l.to, home)}`;

module.exports = { pathTo, loops, linkText };
