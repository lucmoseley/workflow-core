const { isInOtherRepo, refKey, refLabel } = require("./issue-ref.js");
const { judgeProseRefs, proseRefsOf } = require("./prose-blockers.js");

/** @typedef {import("./issue-ref.js").IssueRef} IssueRef */
/**
 * @typedef {IssueRef & {state: string, title: string, url: string, labels: string[], body: string}} Edge
 */
/**
 * @typedef {{ok: true, edges: Edge[]} | {ok: false, error: string, reason?: "unreachable"|"broken"}} EdgesRead
 */
/** @typedef {{ok: true, issue: Edge} | {ok: false, error: string}} IssueRead */
/**
 * @typedef {object} Reads
 * @property {(ref: IssueRef) => Promise<EdgesRead>} blockedBy
 * @property {(ref: IssueRef) => Promise<IssueRead>} issue
 * @property {(ref: IssueRef) => Promise<EdgesRead>} subIssues
 * @property {<T, R>(items: T[], fn: (item: T) => Promise<R>) => Promise<R[]>} each
 */
/**
 * @typedef {object} Node
 * @property {IssueRef} ref
 * @property {boolean} served
 * @property {Edge|null} info
 * @property {{key: string, ref: IssueRef, prose: boolean}[]} blockers
 * @property {Awaited<ReturnType<typeof judgeProseRefs>>} prose
 * @property {string|null} unknown
 */
/** @typedef {{work: number, out: string[], inner: string[]}} Unit */
/** @typedef {{number: number, path: string[]}} Via */

/**
 * @param {IssueRef} ref
 * @param {string|null} home
 * @returns {IssueRef}
 */
const inRepo = (ref, home) => ({
	repo: ref.repo ?? home,
	number: ref.number,
});

/** @returns {Node["prose"]} */
const buildUnreadProse = () => ({ open: [], closed: [], unreadable: [] });

/**
 * @param {{number: number, edges: Edge[], body: string, parent: number|null, openSubIssues: number, map: boolean}[]} served
 * @param {string|null} ownRepo
 * @param {Reads} read
 */
async function blockerGraph(served, ownRepo, read) {
	const openServed = new Set(served.map((s) => s.number));
	/** @param {IssueRef} ref */
	const isServed = (ref) => !isInOtherRepo(ref, ownRepo);
	/** @type {Map<string, Edge>} */
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

	/** @type {Map<string, string[]>} */
	const holds = new Map([...nodes.keys()].map((k) => [k, []]));
	for (const [k, n] of nodes)
		for (const b of n.blockers) holds.get(b.key)?.push(k);
	/** @type {Map<number, number>} */
	const parentOf = new Map();
	/** @type {Map<number, number>} */
	const openChildren = new Map();
	for (const s of served) {
		if (s.parent === null || !openServed.has(s.parent)) continue;
		const p = refKey({ repo: ownRepo, number: s.parent });
		holds.get(refKey({ repo: ownRepo, number: s.number }))?.push(p);
		parentOf.set(s.number, s.parent);
		openChildren.set(s.parent, (openChildren.get(s.parent) ?? 0) + 1);
	}
	// workflow-core#3658
	const toRead = served
		.map((s) => ({ s, local: openChildren.get(s.number) ?? 0 }))
		.filter(
			({ s, local }) => s.openSubIssues > local || (s.map && local === 0),
		);
	/** @type {Map<number, string>} */
	const childrenUnread = new Map();
	const childCounts = await read.each(toRead, async ({ s, local }) => {
		const r = await read.subIssues({ repo: ownRepo, number: s.number });
		if (!r.ok) childrenUnread.set(s.number, r.error);
		const foreign = r.ok
			? r.edges.filter((e) => e.state === "open" && !isServed(e)).length
			: Math.max(0, s.openSubIssues - local);
		return { number: s.number, local, foreign };
	});
	for (const { number, local, foreign } of childCounts)
		if (foreign > 0) openChildren.set(number, local + foreign);
	return { nodes, holds, parentOf, openChildren, childrenUnread, ownRepo };
}

/**
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
 * @param {Graph} graph
 * @param {string} k
 */
const isServedKey = (graph, k) => graph.nodes.get(k)?.served === true;

/**
 * @param {Graph} graph
 * @returns {(a: string, b: string) => number}
 */
const byNumber = (graph) => (a, b) =>
	nodeAt(graph.nodes, a).ref.number - nodeAt(graph.nodes, b).ref.number ||
	a.localeCompare(b);

/**
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
			isServedKey(graph, k) ? [nodeAt(graph.nodes, k).ref.number] : [],
		)
		.sort((a, b) => a - b);
}

/**
 * @param {Graph} graph
 * @param {string} key
 * @returns {Node[]}
 */
function holdersOf(graph, key) {
	if (!graph.nodes.has(key)) return [];
	/** @type {Map<string, string[]>} */
	const heldOutBy = new Map();
	for (const [holder, held] of graph.holds)
		for (const k of held)
			heldOutBy.set(k, [...(heldOutBy.get(k) ?? []), holder]);
	/** @type {Set<string>} */
	const seen = new Set();
	const stack = [key];
	for (let k = stack.pop(); k !== undefined; k = stack.pop()) {
		if (seen.has(k)) continue;
		seen.add(k);
		stack.push(...(heldOutBy.get(k) ?? []));
	}
	return [...seen].sort(byNumber(graph)).map((k) => nodeAt(graph.nodes, k));
}

/**
 * @template {string} T
 * @param {Graph} graph
 * @param {Record<T, (n: number) => boolean>} sources
 * @returns {(ref: IssueRef) => {via: Record<T, Via|null>, depth: number}}
 */
function inheritance(graph, sources) {
	const { unitOf, units } = unitsOf(graph);
	const order = byNumber(graph);
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
			const [source] = [k, ...next.inner].filter(qualifies).sort(order);
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

/** @param {Graph} graph */
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
	const order = byNumber(graph);
	/** @type {Unit[]} */
	const units = members.map((keys, u) => {
		const holds = keys.flatMap((k) => graph.holds.get(k) ?? []);
		return {
			work: keys.filter((k) => isServedKey(graph, k)).length,
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
 * @param {Graph} graph
 * @param {number} n
 */
const reachOf = (graph, n) =>
	heldBy(graph, refKey({ repo: graph.ownRepo, number: n })).length;

/**
 * @param {Graph} graph
 * @param {number} n
 */
function closesOf(graph, n) {
	const seen = new Set([n]);
	let closes = 0;
	for (
		let p = graph.parentOf.get(n);
		p !== undefined && !seen.has(p) && graph.openChildren.get(p) === 1;
		p = graph.parentOf.get(p)
	) {
		seen.add(p);
		closes++;
	}
	return closes;
}

/**
 * @param {Graph} graph
 * @param {number} n
 */
const servedNode = (graph, n) =>
	graph.nodes.get(refKey({ repo: graph.ownRepo, number: n }));

/**
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

/** @param {Graph} graph */
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
	closesOf,
	holdersOf,
	inheritance,
	openBlockersOf,
	proseOf,
	pulledInOf,
	reachOf,
};
