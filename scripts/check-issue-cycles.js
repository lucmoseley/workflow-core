#!/usr/bin/env node
/*
 * check-issue-cycles.js — reports a set of open issues that wait on each other
 * in a loop, so that none of them can ever close (workflow-core#495).
 *
 * TWO KINDS OF LINK, READ TOGETHER. An issue waits on its open blockers
 * (`dependencies/blocked_by`), and a parent waits on its open sub-issues, since
 * it cannot close before they do. A loop needing both kinds is invisible to a
 * check of either alone.
 *
 * Parentage comes from `parent_issue_url` on the open-issues list, one
 * paginated call (check-issue-orphans.js's header says why not /sub_issues).
 * Blockers come from the canonical connection in batches
 * (lib/blocked-by-batch.js), never `issue_dependencies_summary`
 * (docs/agents/issue-tracker.md, "Two dependency graphs").
 *
 * A loop is a strongly connected component of that graph, so it is reported
 * once however many members it has, with one example path naming each link.
 *
 * FAILS CLOSED ON A PARTIAL READ. One unread blocker list could hide the link
 * that closes a loop, so any read failing twice is BROKEN, never OK.
 *
 * WARN, never FAIL: world state, not a commit property. THIS SCRIPT NEVER
 * WRITES — which link is wrong is a judgement about the tickets.
 *
 * Usage: node check-issue-cycles.js [--warn] [--json]
 */

const { runCheck, brokenError, skipError } = require("./lib/check");
const { ghOpenIssues, raiseGhFailure, unreachableRemedy } = require("./lib/gh");
const { blockedByMany } = require("./lib/blocked-by-batch");
const { isInOtherRepo, repoOfUrl } = require("./lib/parent-claims.js");

const CONCLUSION = "No issue-cycle conclusion drawn.";

/** @typedef {{ to: number, kind: "child" | "blocker" }} Edge */

/** @param {string | null | undefined} url */
const parseIssueNumber = (url) => {
	const m = /\/issues\/(\d+)$/.exec(url || "");
	return m ? Number(m[1]) : null;
};

/**
 * @typedef {{
 *   index: Map<number, number>,
 *   low: Map<number, number>,
 *   onStack: Set<number>,
 *   stack: number[],
 *   out: [number, ...number[]][],
 *   counter: number,
 * }} TarjanState
 */

/**
 * @param {TarjanState} st accumulator: the walk's state, `v` indexed and pushed
 * @param {number} v
 */
function discover(st, v) {
	st.index.set(v, st.counter);
	st.low.set(v, st.counter++);
	st.stack.push(v);
	st.onStack.add(v);
}

/**
 * Pops the component rooted at `v` off the stack, keeping it when it has more
 * than one member.
 * @param {TarjanState} st accumulator: the walk's state, the component popped
 *   and kept in `out`
 * @param {number} v
 */
function popComponent(st, v) {
	/** @type {number[]} */
	const comp = [];
	let w;
	do {
		w = /** @type {number} */ (st.stack.pop());
		st.onStack.delete(w);
		comp.push(w);
	} while (w !== v);
	const [lowest, ...rest] = comp.sort((a, b) => a - b);
	if (lowest !== undefined && rest.length > 0) st.out.push([lowest, ...rest]);
}

/**
 * Follows one edge out of `top`, descending into an unvisited target.
 * @param {TarjanState} st accumulator: the walk's state, advanced one edge
 * @param {{ v: number, i: number }[]} work accumulator: the walk's frames, an
 *   unvisited target pushed
 * @param {{ v: number, i: number }} top accumulator: the current frame, its
 *   edge cursor advanced
 * @param {Edge} edge
 */
function followEdge(st, work, top, edge) {
	top.i++;
	const w = edge.to;
	if (!st.index.has(w)) {
		discover(st, w);
		work.push({ v: w, i: 0 });
	} else if (st.onStack.has(w)) {
		st.low.set(
			top.v,
			Math.min(Number(st.low.get(top.v)), Number(st.index.get(w))),
		);
	}
}

/**
 * Leaves `top` once its edges are spent: passes its low-link to its parent and
 * closes its component when it is a root.
 * @param {TarjanState} st accumulator: the walk's state, low-links updated
 * @param {{ v: number, i: number }[]} work accumulator: the walk's frames,
 *   `top` popped
 * @param {{ v: number, i: number }} top
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
 * Tarjan's strongly connected components, iteratively — members of each
 * component sorted ascending, components of one member dropped (a single
 * issue cannot wait on itself through these endpoints).
 * @param {number[]} nodes
 * @param {Map<number, Edge[]>} edges
 * @returns {[number, ...number[]][]}
 */
function loops(nodes, edges) {
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
		/** @type {{ v: number, i: number }[]} */
		const work = [{ v: root, i: 0 }];
		discover(st, root);
		for (let top = work.at(-1); top !== undefined; top = work.at(-1)) {
			const edge = (edges.get(top.v) || [])[top.i];
			if (edge === undefined) finishNode(st, work, top);
			else followEdge(st, work, top, edge);
		}
	}
	return st.out.sort((a, b) => a[0] - b[0]);
}

/**
 * The shortest path from the component's lowest member back to itself, as
 * links.
 * @param {[number, ...number[]]} members
 * @param {Map<number, Edge[]>} edges
 * @returns {{ from: number, to: number, kind: Edge["kind"] }[]}
 */
function examplePath(members, edges) {
	const inComp = new Set(members);
	const start = members[0];
	/** @type {Map<number, { from: number, kind: Edge["kind"] }>} */
	const via = new Map();
	const queue = [start];
	while (queue.length > 0) {
		const v = /** @type {number} */ (queue.shift());
		for (const e of edges.get(v) || []) {
			if (!inComp.has(e.to) || via.has(e.to)) continue;
			via.set(e.to, { from: v, kind: e.kind });
			if (e.to === start) queue.length = 0;
			else queue.push(e.to);
		}
	}
	const path = [];
	let at = start;
	do {
		const step = /** @type {{ from: number, kind: Edge["kind"] }} */ (
			via.get(at)
		);
		path.unshift({ from: step.from, to: at, kind: step.kind });
		at = step.from;
	} while (at !== start);
	return path;
}

/** @param {{ from: number, to: number, kind: Edge["kind"] }} l */
const buildLinkText = (l) =>
	l.kind === "child"
		? `#${l.from} waits on child #${l.to}`
		: `#${l.from} is blocked by #${l.to}`;

/** @param {number[]} members */
const tags = (members) => members.map((n) => `#${n}`);

/**
 * A parent waits on each open sub-issue.
 * @param {any[]} issues
 * @param {Set<number>} open
 * @param {(from: number, e: Edge) => void} add
 */
function addParentEdges(issues, open, add) {
	for (const i of issues) {
		const parent = parseIssueNumber(i.parent_issue_url);
		if (parent !== null && open.has(parent))
			add(parent, { to: i.number, kind: "child" });
	}
}

/**
 * An issue waits on each open blocker in this repository; returns the issues
 * whose blocker list could not be read.
 * @param {any[]} issues
 * @param {Set<number>} open
 * @param {(from: number, e: Edge) => void} add
 * @returns {Promise<string[]>}
 */
async function addBlockerEdges(issues, open, add) {
	// A blocker in another repository shares only its number with ours.
	const home = repoOfUrl(issues.find((i) => i.repository_url)?.repository_url);
	const reads = await blockedByMany(issues, { repo: "{owner}/{repo}", home });
	const unread = [];
	for (const { issue: i, read: r } of reads) {
		if (!r.ok) {
			// An unreachable GitHub is unconcludable, never a fault in the check.
			if (r.reason === "unreachable")
				throw skipError(
					`could not read the blockers of #${i.number} (${r.error}).\n      ` +
						`${unreachableRemedy(Object.assign(new Error(r.error), { stderr: r.error }))} ${CONCLUSION}`,
				);
			unread.push(`#${i.number} (${r.error})`);
			continue;
		}
		for (const b of r.edges)
			if (b.state === "open" && !isInOtherRepo(b, home) && open.has(b.number))
				add(i.number, { to: b.number, kind: "blocker" });
	}
	return unread;
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {{ members: number[], path: { from: number, to: number, kind: Edge["kind"] }[] }[]} cycles
 */
function reportCycles(ctx, cycles) {
	for (const c of cycles)
		ctx.warn(
			"ISSUE-CYCLE",
			`${tags(c.members).join(", ")} wait on each other in a loop`,
			c,
			`ISSUE-CYCLE\t${tags(c.members).join(",")}`,
		);
	if (cycles.length === 0) return;
	ctx.say(`ISSUE-CYCLE (${cycles.length}) — none of these issues can close:`);
	for (const c of cycles) {
		ctx.say(`  ${tags(c.members).join(", ")}`);
		for (const l of c.path) ctx.say(`    ${buildLinkText(l)}`);
	}
	ctx.say(
		"\n  Break the loop at the link that orders nothing. A sub-issue holds its parent open, so work\n" +
			"  ruled not to hold its originator belongs beside it, not under it\n" +
			"  (docs/agents/issue-tracker.md §Placing a new issue).",
	);
}

runCheck({
	name: "issue-cycles",
	usage: "node check-issue-cycles.js [--warn] [--json]",
	async run(/** @type {import("./lib/check").Ctx} */ ctx) {
		/** @type {any[]} */
		let issues = [];
		try {
			issues = ghOpenIssues().filter((i) => !i.pull_request);
		} catch (e) {
			raiseGhFailure(e, CONCLUSION);
		}
		const open = new Set(issues.map((i) => i.number));

		/** @type {Map<number, Edge[]>} */
		const edges = new Map();
		/** @param {number} from @param {Edge} e */
		const add = (from, e) => edges.set(from, [...(edges.get(from) || []), e]);

		addParentEdges(issues, open, add);
		const unread = await addBlockerEdges(issues, open, add);
		if (unread.length > 0)
			throw brokenError(
				`could not read the blockers of ${unread.join(", ")} — an unread list ` +
					`could hide the link that closes a loop. ${CONCLUSION}`,
			);

		const cycles = loops([...open], edges).map((members) => ({
			members,
			path: examplePath(members, edges),
		}));
		ctx.say(`Checked ${issues.length} open issue(s).\n`);
		reportCycles(ctx, cycles);

		return {
			okLine: `no loop among ${issues.length} open issue(s), sub-issue and blocked_by links read together.`,
			noun: "loop(s) among open issues",
			data: { issues: issues.length, cycles, cycleCount: cycles.length },
		};
	},
});
