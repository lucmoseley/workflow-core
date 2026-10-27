/*
 * blocker-graph.js — the open blocked-by graph the shortlist ranks on,
 * followed out of the served repo into any repo it reaches (#2427).
 *
 * Every node is keyed `owner/name#n` (refKey), so a blocker in another repo
 * never credits the served issue that shares its number. From each open
 * served issue the walk follows open native edges and `**Blocked on**`
 * markers into any repo, then those blockers' own, to any depth; the node map
 * is the visited set that ends a cycle. A node outside the served repo costs
 * one blocked_by read, plus one issue read where a marker alone names it.
 *
 * An issue holds out what it blocks and its own open parent in the served
 * repo, which cannot close while it is open (#3222). A parent in another repo
 * is not read.
 *
 * Callers: scripts/pick-next.js, which ranks on reachOf and inheritance,
 * holds on openBlockersOf, and reports pulledInOf's rows and proseOf's
 * markers; and through its `--json` lib/refill-frontier.js.
 */

const { isInOtherRepo, refKey, refLabel } = require("./issue-ref.js");
const { judgeProseRefs, proseRefsOf } = require("./prose-blockers.js");

/** @typedef {import("./issue-ref.js").IssueRef} IssueRef */
/**
 * An issue as a blocked_by or issue read gives it, `repo` resolved.
 * @typedef {IssueRef & {state: string, title: string, url: string, labels: string[], body: string}} Edge
 */
/**
 * `reason` is lib/gh.js's parseGhFailureReason class, where the read knew it.
 * @typedef {{ok: true, edges: Edge[]} | {ok: false, error: string, reason?: "unreachable"|"broken"}} EdgesRead
 */
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
 * @property {Awaited<ReturnType<typeof judgeProseRefs>>} prose every
 *   `**Blocked on**` reference its body names, judged, native edges included
 * @property {string|null} unknown why its blockers could not be read
 */
/**
 * A strongly connected set of nodes: its work count, and the keys of the
 * nodes it holds out directly that lie outside it and inside it.
 * @typedef {{work: number, out: string[], inner: string[]}} Unit
 */
/**
 * Where an issue inherits a tier from: `number`, the held issue carrying it,
 * reached along `path`, each node from the first one held to `number`.
 * @typedef {{number: number, path: string[]}} Via
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
 * A node's verdicts where its body was never read.
 * @returns {Node["prose"]}
 */
const buildUnreadProse = () => ({ open: [], closed: [], unreadable: [] });

/**
 * The graph over `served`'s open issues and every open blocker they reach.
 * @param {{number: number, edges: Edge[], body: string, parent: number|null}[]} served
 *   every open issue in the served repo, its native edges resolved, `parent`
 *   its parent where that is another open issue in the served repo
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
	 * A node's open blockers, native edges first, then markers no edge names,
	 * and its markers' verdicts. An unreadable marker reference holds as open:
	 * launching past a blocker is the one error the shortlist cannot take back.
	 * @param {IssueRef} ref
	 * @param {Edge[]} edges
	 * @param {string} body
	 * @returns {Promise<Pick<Node, "blockers" | "prose">>}
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
		const prose = proseRefsOf(body).map((r) => inRepo(r, ref.repo));
		const judged = await judgeProseRefs(prose, {
			openLocal: openServed,
			ownRepo,
			readIssue: issueOf,
			each: read.each,
		});
		const closed = new Set(judged.closed.map(refKey));
		for (const r of prose)
			if (!named.has(refKey(r)) && !closed.has(refKey(r)))
				out.push({ key: refKey(r), ref: r, prose: true });
		return { blockers: out, prose: judged };
	};

	/** @type {Map<string, Node>} */
	const nodes = new Map();
	const servedNodes = await read.each(served, async (s) => {
		const ref = { repo: ownRepo, number: s.number };
		return {
			ref,
			served: true,
			info: null,
			...(await blockersOf(ref, s.edges, s.body)),
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
				prose: buildUnreadProse(),
				unknown: s.ok ? null : s.error,
			};
			if (!s.ok) return node;
			const d = await read.blockedBy(ref);
			if (!d.ok) return { ...node, unknown: d.error };
			return { ...node, ...(await blockersOf(ref, d.edges, s.issue.body)) };
		});
		for (const n of walked) nodes.set(refKey(n.ref), n);
		layer = unvisited(walked);
	}

	/** @type {Map<string, string[]>} key -> the open nodes it holds out
	 * directly: those it blocks, and its parent */
	const holds = new Map([...nodes.keys()].map((k) => [k, []]));
	for (const [k, n] of nodes)
		for (const b of n.blockers) holds.get(b.key)?.push(k);
	/** @type {Set<string>} open served parents: headings, not work */
	const containers = new Set();
	for (const s of served) {
		if (s.parent === null || !openServed.has(s.parent)) continue;
		const p = refKey({ repo: ownRepo, number: s.parent });
		holds.get(refKey({ repo: ownRepo, number: s.number }))?.push(p);
		containers.add(p);
	}
	return { nodes, holds, containers, ownRepo };
}

/**
 * The node at `k`, which every key `holds` names.
 * @param {Map<string, Node>} nodes
 * @param {string} k
 */
function nodeAt(nodes, k) {
	const n = nodes.get(k);
	if (!n) throw new Error(`blocker graph: no node ${k}`);
	return n;
}

/** @typedef {Awaited<ReturnType<typeof blockerGraph>>} Graph */

/**
 * Whether `k` is work this repo serves: a served node that is no container.
 * @param {Graph} graph
 * @param {string} k
 */
const isWork = (graph, k) =>
	graph.nodes.get(k)?.served === true && !graph.containers.has(k);

/**
 * The served issues `key` transitively holds out, sorted: what its reach
 * counts. A foreign node or a container on the way passes the walk on but is
 * not counted.
 * @param {Graph} graph
 * @param {string} key
 */
function heldBy(graph, key) {
	/** @type {Set<string>} */
	const seen = new Set();
	const stack = [...(graph.holds.get(key) ?? [])];
	for (let k = stack.pop(); k !== undefined; k = stack.pop()) {
		if (seen.has(k)) continue;
		seen.add(k);
		for (const next of graph.holds.get(k) ?? [])
			if (!seen.has(next)) stack.push(next);
	}
	return [...seen]
		.flatMap((k) =>
			isWork(graph, k) ? [nodeAt(graph.nodes, k).ref.number] : [],
		)
		.sort((a, b) => a - b);
}

/**
 * Each tier an issue inherits from what it holds out, and its chain depth
 * (#3222). A tier passes from any held served issue its source test accepts,
 * through foreign nodes as reach does. `depth` is the longest path to the
 * first tier in `sources` order that it holds, else to any served issue it
 * holds (Hu 1961; Kwok and Ahmad 1999). Only a step into work counts. Each
 * `via` names the source at the end of that tier's longest path, a tie going
 * to the lowest number held first. A cycle of holds is one unit: every work
 * issue in it counts, and an issue in it inherits what the cycle holds out.
 * @template {string} T
 * @param {Graph} graph
 * @param {Record<T, (n: number) => boolean>} sources each tier's test of a
 *   served issue, in the order the sort ranks the tiers
 * @returns {(ref: IssueRef) => {via: Record<T, Via|null>, depth: number}}
 */
function inheritance(graph, sources) {
	const { unitOf, units } = unitsOf(graph);
	/** @param {string} a @param {string} b */
	const byNumber = (a, b) =>
		nodeAt(graph.nodes, a).ref.number - nodeAt(graph.nodes, b).ref.number;
	/**
	 * `stop` is the source a path ends on, null where it goes on to `next`.
	 * @typedef {{len: number, next: Unit, entry: string, stop: string|null}} Step
	 */
	/** @param {(n: number) => boolean} isSource */
	const longest = (isSource) => {
		/** @param {string} k */
		const qualifies = (k) => {
			const n = nodeAt(graph.nodes, k);
			return n.served && isSource(n.ref.number);
		};
		/** @type {Map<Unit, Step|null>} filled sinks first, so `next` is set */
		const best = new Map();
		/** @param {string} k @returns {Step|null} */
		const through = (k) => {
			const next = unitOf(k);
			const on = best.get(next);
			const cont = on ? next.work + on.len : Number.NEGATIVE_INFINITY;
			const [source] = [k, ...next.inner].filter(qualifies).sort(byNumber);
			const stop = source === undefined ? Number.NEGATIVE_INFINITY : next.work;
			const len = Math.max(cont, stop);
			if (len === Number.NEGATIVE_INFINITY) return null;
			return {
				len,
				next,
				entry: k,
				stop: source !== undefined && stop >= cont ? source : null,
			};
		};
		for (const unit of units)
			best.set(
				unit,
				unit.out
					.map(through)
					.reduce(
						(a, s) => (s && (!a || s.len > a.len) ? s : a),
						/** @type {Step|null} */ (null),
					),
			);
		/** @param {Unit} u @returns {{len: number, via: Via}|null} */
		return (u) => {
			const first = best.get(u);
			if (!first) return null;
			const keys = [];
			let step = first;
			while (step.stop === null) {
				keys.push(step.entry);
				const on = best.get(step.next);
				if (!on)
					throw new Error(`blocker graph: no path on from ${step.entry}`);
				step = on;
			}
			if (step.stop !== step.entry) keys.push(step.entry);
			keys.push(step.stop);
			return {
				len: first.len,
				via: {
					number: nodeAt(graph.nodes, step.stop).ref.number,
					path: keys.map((key) =>
						refLabel(nodeAt(graph.nodes, key).ref, graph.ownRepo),
					),
				},
			};
		};
	};
	const tiers = /** @type {[T, (n: number) => boolean][]} */ (
		Object.entries(sources)
	).map(([tier, test]) => /** @type {const} */ ([tier, longest(test)]));
	const anyServed = longest(() => true);
	return (ref) => {
		const u = unitOf(refKey(ref));
		const via = /** @type {Record<T, Via|null>} */ ({});
		/** @type {number|null} */
		let depth = null;
		for (const [tier, path] of tiers) {
			const p = path(u);
			via[tier] = p?.via ?? null;
			if (p && depth === null) depth = p.len;
		}
		return { via, depth: depth ?? anyServed(u)?.len ?? 0 };
	};
}

/**
 * The graph's strongly connected components (Tarjan 1972), sinks first, so
 * the longest-path pass runs on an acyclic graph.
 * @param {Graph} graph
 */
function unitsOf(graph) {
	/** @type {Map<string, {index: number, low: number}>} */
	const meta = new Map();
	/** @type {Map<string, number>} */
	const unitIndex = new Map();
	/** @type {string[][]} */
	const members = [];
	/** @type {string[]} */
	const stack = [];
	/** @param {string} k */
	const visit = (k) => {
		const me = { index: meta.size, low: meta.size };
		meta.set(k, me);
		stack.push(k);
		for (const held of graph.holds.get(k) ?? []) {
			const seen = meta.get(held);
			if (!seen) me.low = Math.min(me.low, visit(held).low);
			else if (!unitIndex.has(held)) me.low = Math.min(me.low, seen.index);
		}
		if (me.low === me.index) {
			const unit = stack.splice(stack.lastIndexOf(k));
			for (const m of unit) unitIndex.set(m, members.length);
			members.push(unit);
		}
		return me;
	};
	for (const k of graph.nodes.keys()) if (!meta.has(k)) visit(k);
	/** @param {string} a @param {string} b */
	const order = (a, b) =>
		nodeAt(graph.nodes, a).ref.number - nodeAt(graph.nodes, b).ref.number ||
		a.localeCompare(b);
	/** @type {Unit[]} */
	const units = members.map((keys, u) => {
		const holds = keys.flatMap((k) => graph.holds.get(k) ?? []);
		return {
			work: keys.filter((k) => isWork(graph, k)).length,
			out: holds.filter((k) => unitIndex.get(k) !== u).sort(order),
			inner: holds.filter((k) => unitIndex.get(k) === u),
		};
	});
	/** @param {string} k */
	const unitOf = (k) => {
		const u = units[unitIndex.get(k) ?? -1];
		if (!u) throw new Error(`blocker graph: no node ${k}`);
		return u;
	};
	return { unitOf, units };
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
 * The node of served issue `n`, undefined where the graph has none.
 * @param {Graph} graph
 * @param {number} n
 */
const servedNode = (graph, n) =>
	graph.nodes.get(refKey({ repo: graph.ownRepo, number: n }));

/**
 * A served issue's open blockers as a reader sees them, its own repo's by
 * number, then `owner/name#n` for those in another; `native` is false for a
 * marker-only one.
 * @param {Graph} graph
 * @param {number} n
 * @returns {{label: string, native: boolean}[]}
 */
function openBlockersOf(graph, n) {
	const node = servedNode(graph, n);
	return inReadingOrder(node?.blockers ?? [], (b) => b.ref, graph.ownRepo).map(
		(b) => ({ label: refLabel(b.ref, graph.ownRepo), native: !b.prose }),
	);
}

/**
 * `items` its own repo's first by number, then those in another by key.
 * @template T
 * @param {T[]} items
 * @param {(item: T) => IssueRef} refOf
 * @param {string|null} ownRepo
 */
function inReadingOrder(items, refOf, ownRepo) {
	const own = items
		.filter((i) => !isInOtherRepo(refOf(i), ownRepo))
		.sort((a, b) => refOf(a).number - refOf(b).number);
	const foreign = items
		.filter((i) => isInOtherRepo(refOf(i), ownRepo))
		.sort((a, b) => refKey(refOf(a)).localeCompare(refKey(refOf(b))));
	return [...own, ...foreign];
}

/**
 * A served issue's `**Blocked on**` references as a reader sees them, in
 * openBlockersOf's order, split as judgeProseRefs judged them; `named` is
 * every one.
 * @param {Graph} graph
 * @param {number} n
 */
function proseOf(graph, n) {
	const node = servedNode(graph, n);
	const prose = node?.prose ?? buildUnreadProse();
	/** @param {IssueRef[]} refs */
	const labels = (refs) =>
		inReadingOrder(refs, (r) => r, graph.ownRepo).map((r) =>
			refLabel(r, graph.ownRepo),
		);
	return {
		named: labels([
			...prose.open,
			...prose.closed,
			...prose.unreadable.map((u) => u.ref),
		]),
		open: labels(prose.open),
		closed: labels(prose.closed),
		unreadable: inReadingOrder(
			prose.unreadable,
			(u) => u.ref,
			graph.ownRepo,
		).map((u) => ({ ref: refLabel(u.ref, graph.ownRepo), error: u.error })),
	};
}

/**
 * Every open issue in another repo that holds a served issue out and that
 * nothing open holds itself: a launch candidate for its own repo (#2427).
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
	inheritance,
	openBlockersOf,
	proseOf,
	pulledInOf,
	reachOf,
};
