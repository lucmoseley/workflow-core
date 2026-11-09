// @vitest-environment node
/*
 * Pins pick-next's verdict on each open issue (#4329): why it is held out of
 * the frontier, earliest-applicable reason first, the tiers it ranks on, its
 * wait, and the frontier's order (mantahostels#102, mantahostels#105,
 * mantahostels#106, #2664, #3222).
 *
 * Loosen a case and `/pick-next` offers a blocked, claimed, gated or
 * container issue as takeable, or ranks the queue so the wrong ticket leads.
 */
import { describe, expect, it } from "vitest";

const {
	enrichAll,
	kindSetsOf,
	proseBlockedOf,
	rankFrontier,
	waitCell,
} = require("./pick-next-verdict.js");
const blockerGraph = require("./blocker-graph.js");

const OWN = "me/served";
const NOW = Date.parse("2026-11-05T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

interface FxIssue {
	number: number;
	labels?: string[];
	assignees?: string[];
	body?: string;
	parent?: number;
	openSubIssues?: number;
	/** why its blocker read failed */
	depsUnknown?: string;
}
interface Fx {
	issues: FxIssue[];
	/** issue -> the served issues blocking it, with their state */
	deps?: Record<number, { number: number; state: "open" | "closed" }[]>;
	/** issues whose sub-issues read fails */
	failSubIssues?: number[];
	/** issue -> each label put on it, how many days ago, and by whom */
	timeline?: Record<number, { label: string; days: number; actor?: string }[]>;
	/** issue -> the session holding its claim */
	claims?: Record<number, string>;
	/** the claims were kept on a degraded oracle read */
	kept?: boolean;
	/** issue -> the ledger entries holding it */
	dispatched?: Record<number, Record<string, unknown>[]>;
	/** issue -> the parent map whose claim holds it, and that claim's session */
	parentHeld?: Record<number, { label: string; sessionId: string }>;
	goal?: number[];
}

const edge = (n: number, state: string) => ({
	repo: OWN,
	number: n,
	state,
	title: `issue #${n}`,
	url: `http://example/${n}`,
	labels: [],
	body: "",
});

const ledgerEntry = (n: number, over: Record<string, unknown> = {}) => ({
	ts: daysAgo(0.01),
	issues: [n],
	model: "opus",
	prompt: `/implement ${n}`,
	session: "launcher",
	jobId: null,
	...over,
});

/** Every issue's verdict and the frontier, over fake reads in the served repo. */
async function verdictOf(fx: Fx) {
	const raw = fx.issues.map((i) => ({
		number: i.number,
		state: "open",
		title: `issue ${i.number}`,
		url: `http://example/${i.number}`,
		createdAt: daysAgo(30),
		assignees: i.assignees ?? [],
		labels: i.labels ?? [],
		body: i.body ?? "",
		parent: i.parent ? `#${i.parent}` : null,
		openSubIssues: i.openSubIssues ?? 0,
		repo: OWN,
		blockedBy: (fx.deps?.[i.number] ?? []).map((d) => edge(d.number, d.state)),
		depsUnknown: i.depsUnknown ?? null,
	}));
	const failing = async () => ({ ok: false, error: "HTTP 502" });
	const graph = await blockerGraph.blockerGraph(
		raw.map((i) => ({
			number: i.number,
			edges: i.blockedBy,
			body: i.body,
			parent: fx.issues.find((f) => f.number === i.number)?.parent ?? null,
			openSubIssues: i.openSubIssues,
			map: i.labels.includes("wayfinder:map"),
		})),
		OWN,
		{
			blockedBy: failing,
			issue: failing,
			subIssues: async (ref: { number: number }) =>
				fx.failSubIssues?.includes(ref.number)
					? { ok: false, error: "HTTP 502" }
					: { ok: true, edges: [] },
			each: <T, R>(items: T[], fn: (item: T) => Promise<R>) =>
				Promise.all(items.map(fn)),
		},
	);
	const withDeps = raw.map((i) => ({
		...i,
		proseBlocked: proseBlockedOf(graph, i),
	}));
	const byNumber = new Map(raw.map((i) => [i.number, i]));
	const goalRanked = new Set(fx.goal ?? []);
	const timelineByIssue = new Map(
		Object.entries(fx.timeline ?? {}).map(([n, events]) => [
			Number(n),
			{
				ok: true,
				events: events.map((e) => ({
					event: "labeled",
					label: { name: e.label },
					created_at: daysAgo(e.days),
					actor: { login: e.actor ?? "owner" },
				})),
			},
		]),
	);
	const ctx = {
		blockers: graph,
		timelineByIssue,
		...kindSetsOf(raw),
		listed: {
			ids: new Set(["self"]),
			names: new Map(),
			finished: new Set(),
			terminal: new Set(),
			pids: new Map(),
		},
		claims: {
			held: new Map(
				Object.entries(fx.claims ?? {}).map(([n, s]) => [Number(n), s]),
			),
			kept: fx.kept ?? false,
		},
		parentHeld: {
			held: new Map(
				Object.entries(fx.parentHeld ?? {}).map(([n, p]) => [
					Number(n),
					{ ...p, kept: false },
				]),
			),
		},
		dispatched: {
			byIssue: new Map(
				Object.entries(fx.dispatched ?? {}).map(([n, recs]) => [
					Number(n),
					recs,
				]),
			),
		},
		openChildren: graph.openChildren,
		goalRanked,
		now: () => NOW,
	};
	const { enriched } = enrichAll(withDeps, byNumber, ctx);
	const frontier = rankFrontier(enriched);
	const of = (n: number) => {
		const hit = enriched.find((i: { number: number }) => i.number === n);
		if (!hit) throw new Error(`no issue #${n}`);
		return hit;
	};
	return {
		of,
		frontier,
		order: frontier.map((i: { number: number }) => i.number),
	};
}

const GATE_CONDITION =
	"the eleven tickets have cleared the 5-day rework horizon";
const GATE_ON = `Some body text.\n\n**Gated on:** ${GATE_CONDITION} — check: python3 scan_rework.py — abandon if: the label stops being applied\n\nMore text.`;

describe("why an issue is held out of the frontier", () => {
	it("names each exclusion's tally category beside its reason (#4381)", async () => {
		const v = await verdictOf({
			issues: [
				{ number: 1 },
				{ number: 2, depsUnknown: "HTTP 502" },
				{ number: 3 },
				{ number: 4, assignees: ["owner"] },
				{ number: 5 },
				{ number: 6 },
				{ number: 7 },
				{ number: 10, parent: 7 },
				{ number: 8, body: "**Gated until:** 2099-01-01 — later" },
				{ number: 9, body: GATE_ON },
			],
			deps: { 3: [{ number: 1, state: "open" }] },
			claims: { 4: "s1" },
			parentHeld: { 5: { label: "#40", sessionId: "s2" } },
			dispatched: { 6: [ledgerEntry(6)] },
		});
		const reasonAndCategory = (n: number) => [
			String(v.of(n).excluded).split(" ").slice(0, 2).join(" "),
			v.of(n).exclusionCategory,
		];
		expect([2, 3, 4, 5, 6, 7, 8, 9].map(reasonAndCategory)).toEqual([
			["readiness unknown", "degraded"],
			["blocked by", "blocked"],
			["claimed by", "claimed"],
			["claimed through", "claimed"],
			["dispatched 0.2h", "already dispatched"],
			["container —", "container"],
			["gated until", "gated"],
			["gated on", "gated"],
		]);
		expect(v.of(1).exclusionCategory).toBeNull();
	});

	it("excludes an issue whose prose `**Blocked on**` names a still-open issue (mantahostels#1289)", async () => {
		const v = await verdictOf({
			issues: [{ number: 831 }, { number: 832, body: "**Blocked on** #831." }],
		});
		expect(v.order).toEqual([831]);
		expect(v.of(832).excluded).toBe("blocked by #831 (prose only)");
	});

	it("excludes an unlabelled open issue with an open child", async () => {
		const v = await verdictOf({
			issues: [
				{ number: 40 },
				{ number: 78, parent: 40 },
				{ number: 83, parent: 40 },
			],
		});
		expect(v.order).toEqual([78, 83]);
		expect(v.of(40).excluded).toBe("container — 2 open children");
	});

	it("holds a takes:children and a takes:wayfinder issue with an open child as containers (#4767)", async () => {
		const v = await verdictOf({
			issues: [
				{ number: 40, labels: ["takes:children"] },
				{ number: 41, parent: 40 },
				{ number: 50, labels: ["takes:wayfinder"] },
				{ number: 51, parent: 50 },
			],
		});
		expect(v.of(40).excluded).toBe("container — 1 open children");
		expect(v.of(50).excluded).toBe("container — 1 open children");
	});

	it("offers a takes:to-spec map whose open children are blocked or gated (#4767)", async () => {
		const v = await verdictOf({
			issues: [
				{ number: 2809, labels: ["takes:to-spec"] },
				{ number: 2726 },
				{ number: 2827, parent: 2809 },
				{
					number: 2828,
					parent: 2809,
					body: "**Gated until:** 2099-01-01 — later",
				},
			],
			deps: { 2827: [{ number: 2726, state: "open" }] },
		});
		expect(v.of(2809).excluded).toBeNull();
		expect(v.order).toContain(2809);
		expect(v.of(2827).exclusionCategory).toBe("blocked");
		expect(v.of(2828).exclusionCategory).toBe("gated");
	});

	it("holds a map back on its summary where its sub-issues cannot be read, saying so (#3658)", async () => {
		const v = await verdictOf({
			issues: [{ number: 40, openSubIssues: 1 }, { number: 41 }],
			failSubIssues: [40],
		});
		expect(v.order).toEqual([41]);
		expect(v.of(40).excluded).toBe(
			"container — 1 open children by its summary; sub-issues unreadable (HTTP 502)",
		);
	});

	it("treats an assignee as the claim and names them", async () => {
		const v = await verdictOf({
			issues: [{ number: 1, assignees: ["owner"] }, { number: 2 }],
			claims: { 1: "self" },
		});
		expect(v.order).toEqual([2]);
		expect(v.of(1).excluded).toBe("claimed by owner");
	});

	it("names the recording session where a live claim carries no assignee", async () => {
		const v = await verdictOf({
			issues: [{ number: 1 }, { number: 2 }],
			claims: { 1: "alice" },
		});
		expect(v.order).toEqual([2]);
		expect(v.of(1).excluded).toBe("claimed by session alice");
	});

	it("hedges the holder where the claim was kept on an unread oracle", async () => {
		const v = await verdictOf({
			issues: [{ number: 1 }, { number: 2 }],
			claims: { 1: "s" },
			kept: true,
		});
		expect(v.of(1).excluded).toBe("claimed by session s, liveness unread");
	});

	it("does not hedge the holder where the oracle answered", async () => {
		const v = await verdictOf({
			issues: [{ number: 1 }, { number: 2 }],
			claims: { 1: "alice" },
		});
		expect(v.of(1).excluded).not.toMatch(/liveness unread/);
	});

	it("never filters on a readiness label, since no close clears one", async () => {
		const v = await verdictOf({
			issues: [{ number: 1 }, { number: 2, labels: ["takes:implement"] }],
		});
		expect(v.order).toEqual([1, 2]);
	});

	it("keeps a waiting issue in the frontier", async () => {
		const v = await verdictOf({
			issues: [{ number: 1, labels: ["waiting:external"] }, { number: 2 }],
			timeline: { 1: [{ label: "waiting:external", days: 60 }] },
		});
		expect(v.order).toContain(1);
		expect(v.of(1).excluded).toBeNull();
	});

	it("excludes a dispatched issue though no session from that launch is still listed", async () => {
		// The listing holds "self" alone: the ledger limb is unconditional
		// inside the window.
		const v = await verdictOf({
			issues: [{ number: 2 }],
			dispatched: { 2: [ledgerEntry(2)] },
		});
		expect(v.order).toEqual([]);
		expect(v.of(2).excluded).toMatch(/^dispatched /);
		expect(v.of(2).dispatchHeld).toBe(true);
	});

	it("lets a live claim keep the reason over a dispatch, since it names the holder", async () => {
		const v = await verdictOf({
			issues: [{ number: 1 }, { number: 2, assignees: ["someone"] }],
			claims: { 2: "s1" },
			dispatched: { 2: [ledgerEntry(2)] },
		});
		expect(v.of(2).excluded).toBe("claimed by someone");
		// Not dispatch-held, so it stays out of the dispatched block and its count.
		expect(v.of(2).dispatchHeld).toBe(false);
	});

	it("reports a concrete blocker instead of the gate when both apply", async () => {
		const v = await verdictOf({
			issues: [
				{ number: 1 },
				{
					number: 85,
					body: "**Gated until:** 2099-01-01 — waiting on Bunkward",
				},
			],
			deps: { 85: [{ number: 1, state: "open" }] },
		});
		expect(v.of(85).gateHolds).toBe(true);
		expect(v.of(85).excluded).toBe("blocked by #1");
	});

	it("states the condition in the exclusion reason, never a date", async () => {
		const v = await verdictOf({
			issues: [
				{ number: 1 },
				{ number: 1215, body: GATE_ON, labels: ["waiting:external"] },
			],
			timeline: { 1215: [{ label: "waiting:external", days: 5 }] },
		});
		expect(v.of(1215).excluded).toBe(`gated on ${GATE_CONDITION}`);
	});

	it("holds a conditioned goal-set member out of the frontier (#3102)", async () => {
		const v = await verdictOf({
			issues: [{ number: 1 }, { number: 1215, body: GATE_ON }],
			goal: [1215],
		});
		expect(v.of(1215).goal).toBe(true);
		expect(v.order).toEqual([1]);
	});
});

describe("assigned but unclaimed", () => {
	it("offers an assigned issue no session ever claimed — the fail-open case", async () => {
		const v = await verdictOf({
			issues: [{ number: 1, assignees: ["owner"] }, { number: 2 }],
		});
		expect(v.order).toEqual([1, 2]);
		expect(v.of(1).assignedUnclaimed).toBe(true);
	});

	it("leaves a blocked issue out, whatever its stale assignee", async () => {
		const v = await verdictOf({
			issues: [{ number: 1, assignees: ["owner"] }, { number: 2 }],
			deps: { 1: [{ number: 2, state: "open" }] },
		});
		expect(v.of(1).excluded).toBe("blocked by #2");
		expect(v.of(1).assignedUnclaimed).toBe(false);
	});

	it("never reports a dispatched issue as assigned-but-unclaimed", async () => {
		const v = await verdictOf({
			issues: [{ number: 2, assignees: ["someone"] }],
			dispatched: { 2: [ledgerEntry(2)] },
		});
		expect(v.of(2).assignedUnclaimed).toBe(false);
	});
});

describe("the tiers an issue ranks on", () => {
	it("keeps an urgent applied 9 days ago in the urgent band — it never expires (#2664)", async () => {
		const v = await verdictOf({
			issues: [{ number: 1 }, { number: 3, labels: ["urgent"] }],
			timeline: { 3: [{ label: "urgent", days: 9 }] },
		});
		expect(v.order).toEqual([3, 1]);
		expect(v.of(3)).toMatchObject({
			urgent: true,
			urgency: { ageDays: 9, appliedBy: "owner" },
		});
	});

	it("ranks an unlabelled bug above an urgent non-bug (#2664)", async () => {
		const v = await verdictOf({
			issues: [
				{ number: 1 },
				{ number: 2, labels: ["urgent"] },
				{ number: 3, labels: ["bug"] },
			],
			timeline: { 2: [{ label: "urgent", days: 1 }] },
		});
		expect(v.order).toEqual([3, 2, 1]);
		expect(v.of(3)).toMatchObject({ bug: true, urgent: true, urgentVia: null });
	});

	it("passes goal-set membership to every issue holding a member out (#3222)", async () => {
		// #2 blocks #3, whose parent #5 is the goal; #1 holds nothing.
		const v = await verdictOf({
			issues: [
				{ number: 1 },
				{ number: 2 },
				{ number: 3, parent: 5 },
				{ number: 5 },
			],
			deps: { 3: [{ number: 2, state: "open" }] },
			goal: [5],
		});
		expect(v.order).toEqual([2, 1]);
		expect(v.of(2)).toMatchObject({
			goal: true,
			goalVia: { number: 5, path: ["#3", "#5"] },
		});
		expect(v.of(1)).toMatchObject({ goal: false, goalVia: null, depth: 0 });
	});
});

describe("the frontier's order", () => {
	it("breaks a tie within each ticket-type band toward the ticket that writes no repo file", async () => {
		const v = await verdictOf({
			issues: [
				{ number: 1, labels: ["kind:ticket"] },
				{ number: 2, labels: ["wayfinder:grilling", "takes:wayfinder"] },
				{ number: 3, labels: ["wayfinder:research"] },
				{ number: 4, labels: ["takes:wayfinder"] },
			],
		});
		expect(v.order).toEqual([2, 4, 3, 1]);
		expect(v.of(3).collision).toBeLessThan(v.of(1).collision);
	});

	it("puts a question-asking ticket above an implement ticket with higher reach", async () => {
		const v = await verdictOf({
			issues: [
				{ number: 1, labels: ["wayfinder:grilling", "takes:wayfinder"] },
				{ number: 2, labels: ["kind:ticket", "takes:implement"] },
				{ number: 3 },
				{ number: 4, labels: ["wayfinder:prototype", "takes:wayfinder"] },
				{ number: 5, labels: ["takes:wayfinder"] },
				{ number: 6, labels: ["wayfinder:map", "takes:wayfinder"] },
				{ number: 7, labels: ["wayfinder:grilling", "takes:implement"] },
			],
			deps: { 3: [{ number: 2, state: "open" }] },
		});
		expect(v.order).toEqual([1, 4, 5, 2, 7, 6]);
		expect(v.of(1).asksQuestions).toBe(true);
		expect(v.of(2).reach).toBe(1);
		expect(v.of(2).asksQuestions).toBe(false);
		// A `takes:` value overrides the type label that disagrees with it.
		expect(v.of(7).asksQuestions).toBe(false);
		// A map asks nothing by itself, though it takes /wayfinder.
		expect(v.of(6).asksQuestions).toBe(false);
	});

	it("falls back to issue number when every other level ties", async () => {
		const v = await verdictOf({
			issues: [{ number: 9 }, { number: 4 }, { number: 7 }],
		});
		expect(v.order).toEqual([4, 7, 9]);
	});
});

describe("the waiting:external escalation", () => {
	// #2 outranks #1 on reach, so only a firing stall can invert the pair.
	const pair = [
		{ number: 1, labels: ["waiting:external"] },
		{ number: 2 },
		{ number: 3 },
	];
	const deps = { 3: [{ number: 2, state: "open" as const }] };
	const waiting = (days: number) => ({
		1: [{ label: "waiting:external", days }],
	});

	it("leaves a wait under the threshold ranked exactly as an unlabelled one", async () => {
		const v = await verdictOf({ issues: pair, deps, timeline: waiting(3) });
		expect(v.order).toEqual([2, 1]);
		expect(v.of(1).stallDays).toBe(0);
		expect(waitCell(v.of(1))).toBe("3d");
	});

	it("escalates on either side of the 7-day threshold", async () => {
		const under = await verdictOf({
			issues: pair,
			deps,
			timeline: waiting(6.9),
		});
		expect(under.order).toEqual([2, 1]);
		expect(waitCell(under.of(1))).toBe("6d");

		const over = await verdictOf({
			issues: pair,
			deps,
			timeline: waiting(7.1),
		});
		expect(over.order).toEqual([1, 2]);
		expect(waitCell(over.of(1))).toBe("7d!");
	});
});

describe("kindSetsOf", () => {
	it("takes a map by its exact label and a spec by `kind:spec`, nothing near either", () => {
		const issue = (number: number, labels: string[]) =>
			({ number, labels }) as { number: number; labels: string[] };
		const sets = kindSetsOf([
			issue(1, ["wayfinder:map"]),
			issue(2, ["wayfinder:mapped"]),
			issue(3, ["kind:spec"]),
			issue(4, []),
		] as never);
		expect([...sets.mapNumbers]).toEqual([1]);
		expect([...sets.specNumbers]).toEqual([3]);
	});
});
