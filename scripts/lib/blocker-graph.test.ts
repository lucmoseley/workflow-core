// @vitest-environment node
/*
 * Pins the blocked-by graph the shortlist ranks on (#2427): the walk out of
 * the served repo into any repo, the issues it pulls in as launch
 * candidates, and keys that keep a foreign number from crediting the served
 * issue sharing it. Driven through fake reads, so no `gh` runs. Loosen a
 * case and the refill loop launches a ticket another repo's open issue still
 * blocks, or ranks a served issue on a foreign issue's reach.
 */

import { describe, expect, it } from "vitest";

const {
	blockerGraph,
	inheritance,
	openBlockersOf,
	proseOf,
	pulledInOf,
	reachOf,
} = require("./blocker-graph.js");

type State = "open" | "closed";
interface Fake {
	/** `owner/name#n` -> its state and body */
	issues?: Record<string, { state: State; body?: string }>;
	/** `owner/name#n` -> the refs blocking it */
	deps?: Record<string, string[]>;
	/** `owner/name#n` whose blocked_by read fails */
	failDeps?: string[];
	/** `owner/name#n` whose issue read fails */
	failIssues?: string[];
}

const OWN = "me/served";

const parse = (ref: string) => {
	const [repo, n] = ref.split("#");
	return { repo: repo || null, number: Number(n) };
};

const edge = (fake: Fake, ref: string) => {
	const r = parse(ref);
	const i = fake.issues?.[ref] ?? { state: "open" as State };
	return {
		...r,
		state: i.state,
		title: `issue ${ref}`,
		url: `http://example/${ref}`,
		labels: [],
		body: i.body ?? "",
	};
};

/** A served repo of `served` (number -> its blockers, body and parent), over `fake`. */
const graphOf = (
	served: Record<number, { deps?: string[]; body?: string; parent?: number }>,
	fake: Fake = {},
) => {
	const reads: string[] = [];
	const read = {
		blockedBy: async (ref: { repo: string; number: number }) => {
			const key = `${ref.repo}#${ref.number}`;
			reads.push(`deps ${key}`);
			if (fake.failDeps?.includes(key)) return { ok: false, error: "HTTP 502" };
			return {
				ok: true,
				edges: (fake.deps?.[key] ?? []).map((d) => edge(fake, d)),
			};
		},
		issue: async (ref: { repo: string; number: number }) => {
			const key = `${ref.repo}#${ref.number}`;
			reads.push(`issue ${key}`);
			if (fake.failIssues?.includes(key))
				return { ok: false, error: "HTTP 404" };
			return { ok: true, issue: edge(fake, key) };
		},
		each: <T, R>(items: T[], fn: (item: T) => Promise<R>) =>
			Promise.all(items.map(fn)),
	};
	return blockerGraph(
		Object.entries(served).map(([n, s]) => ({
			number: Number(n),
			edges: (s.deps ?? []).map((d) => edge(fake, d)),
			body: s.body ?? "",
			parent: s.parent ?? null,
		})),
		OWN,
		read,
	).then((graph: unknown) => ({ graph, reads }));
};

const pulled = (graph: unknown) =>
	pulledInOf(graph).rows.map(
		(r: { repo: string; number: number; reach: number; holds: string[] }) =>
			`${r.repo}#${r.number} reach ${r.reach} holds ${r.holds.join(",")}`,
	);

describe("the walk into other repos", () => {
	it("pulls in the foreign blocker at the chain's open end, not the one it blocks", async () => {
		const { graph } = await graphOf(
			{ 1: { deps: ["o/y#10"] } },
			{ deps: { "o/y#10": ["o/z#20"] } },
		);
		expect(pulled(graph)).toEqual(["o/z#20 reach 1 holds me/served#1"]);
		expect(openBlockersOf(graph, 1)).toEqual([
			{ label: "o/y#10", native: true },
		]);
	});

	it("pulls in the next blocker once the far end closes", async () => {
		const { graph } = await graphOf(
			{ 1: { deps: ["o/y#10"] } },
			{
				deps: { "o/y#10": ["o/z#20"] },
				issues: { "o/z#20": { state: "closed" } },
			},
		);
		expect(pulled(graph)).toEqual(["o/y#10 reach 1 holds me/served#1"]);
	});

	it("counts every served issue a blocker holds out, through a served one", async () => {
		const { graph } = await graphOf(
			{ 1: { deps: ["o/y#10"] }, 2: { deps: [`${OWN}#1`] }, 3: {} },
			{},
		);
		expect(pulled(graph)).toEqual([
			"o/y#10 reach 2 holds me/served#1,me/served#2",
		]);
		expect(reachOf(graph, 1)).toBe(1);
	});

	it("ends on a cycle between two foreign issues, pulling neither in", async () => {
		const { graph, reads } = await graphOf(
			{ 1: { deps: ["o/y#10"] } },
			{ deps: { "o/y#10": ["o/z#20"], "o/z#20": ["o/y#10"] } },
		);
		expect(pulled(graph)).toEqual([]);
		expect(reads.filter((r: string) => r.startsWith("deps")).sort()).toEqual([
			"deps o/y#10",
			"deps o/z#20",
		]);
	});

	it("never walks a closed foreign blocker", async () => {
		const { graph, reads } = await graphOf(
			{ 1: { deps: ["o/y#10"] } },
			{ issues: { "o/y#10": { state: "closed" } } },
		);
		expect(pulled(graph)).toEqual([]);
		expect(reads).toEqual([]);
		expect(openBlockersOf(graph, 1)).toEqual([]);
	});

	it("offers no foreign blocker whose own blockers would not read", async () => {
		const { graph } = await graphOf(
			{ 1: { deps: ["o/y#10"] } },
			{ failDeps: ["o/y#10"] },
		);
		expect(pulled(graph)).toEqual([]);
		expect(pulledInOf(graph).unread).toEqual([
			{ ref: "o/y#10", error: "HTTP 502", holds: ["me/served#1"] },
		]);
	});
});

describe("a foreign number shared with a served issue", () => {
	it("credits no reach to the served issue carrying it", async () => {
		const { graph } = await graphOf({ 1: { deps: ["o/y#5"] }, 5: {} }, {});
		expect(reachOf(graph, 5)).toBe(0);
		expect(pulled(graph)).toEqual(["o/y#5 reach 1 holds me/served#1"]);
	});
});

describe("what an issue inherits from what it holds out (#3222)", () => {
	/** `urgent` from each issue in `urgent`. */
	const urgentOf = (graph: unknown, urgent: number[]) =>
		inheritance(graph, { urgent: (n: number) => urgent.includes(n) });
	const own = (number: number) => ({ repo: OWN, number });

	it("passes a tier along a blocker chain, its depth the longest path", async () => {
		// 1 blocks 2 and 3; 3 blocks 4, which is urgent. 2 is a shorter dead end.
		const { graph } = await graphOf({
			1: {},
			2: { deps: [`${OWN}#1`] },
			3: { deps: [`${OWN}#1`] },
			4: { deps: [`${OWN}#3`] },
		});
		expect(urgentOf(graph, [4])(own(1))).toEqual({
			via: { urgent: { number: 4, path: ["#3", "#4"] } },
			depth: 2,
		});
	});

	it("ends on a cycle, still naming the tier past it", async () => {
		// 1 blocks 2; 2 and 3 block each other; 3 is urgent.
		const { graph } = await graphOf({
			1: {},
			2: { deps: [`${OWN}#1`, `${OWN}#3`] },
			3: { deps: [`${OWN}#2`] },
		});
		expect(urgentOf(graph, [3])(own(1))).toEqual({
			via: { urgent: { number: 3, path: ["#2", "#3"] } },
			depth: 2,
		});
	});

	it("answers the same into a cycle from either side, whichever is asked first", async () => {
		// 1 blocks 2 and 4 blocks 3; 2 and 3 block each other; 2 blocks 5, urgent.
		const { graph } = await graphOf({
			1: {},
			4: {},
			2: { deps: [`${OWN}#1`, `${OWN}#3`] },
			3: { deps: [`${OWN}#4`, `${OWN}#2`] },
			5: { deps: [`${OWN}#2`] },
		});
		const want = {
			1: { via: { urgent: { number: 5, path: ["#2", "#5"] } }, depth: 3 },
			4: { via: { urgent: { number: 5, path: ["#3", "#5"] } }, depth: 3 },
		};
		for (const order of [
			[1, 4],
			[4, 1],
		]) {
			const of = urgentOf(graph, [5]);
			for (const n of order)
				expect(of(own(n))).toEqual(want[n as keyof typeof want]);
		}
	});

	it("holds a child's open parent, counting it in neither reach nor depth", async () => {
		const { graph } = await graphOf({
			1: {},
			2: { deps: [`${OWN}#1`], parent: 5 },
			5: {},
		});
		expect(reachOf(graph, 1)).toBe(1);
		expect(urgentOf(graph, [5])(own(1))).toEqual({
			via: { urgent: { number: 5, path: ["#2", "#5"] } },
			depth: 1,
		});
	});

	it("passes urgency down a parent link to a child, then on to its blockers (#3250)", async () => {
		// 5 is the parent of 2; 1 blocks 2; 1 is the parent of 3.
		const { graph } = await graphOf({
			1: {},
			2: { deps: [`${OWN}#1`], parent: 5 },
			3: { parent: 1 },
			5: {},
		});
		expect(urgentOf(graph, [5])(own(3))).toEqual({
			via: { urgent: { number: 5, path: ["#1", "#2", "#5"] } },
			depth: 1,
		});
	});

	it("passes a served tier on to a foreign issue through a foreign one", async () => {
		const { graph } = await graphOf(
			{ 1: { deps: ["o/y#10"] } },
			{ deps: { "o/y#10": ["o/z#20"] } },
		);
		expect(urgentOf(graph, [1])({ repo: "o/z", number: 20 })).toEqual({
			via: { urgent: { number: 1, path: ["o/y#10", "#1"] } },
			depth: 1,
		});
	});
});

describe("`**Blocked on**` markers naming another repo", () => {
	it("hold a served issue on an open one, read once, as prose only", async () => {
		const { graph, reads } = await graphOf(
			{ 1: { body: "**Blocked on** o/y#10." } },
			{},
		);
		expect(openBlockersOf(graph, 1)).toEqual([
			{ label: "o/y#10", native: false },
		]);
		expect(reads.filter((r: string) => r === "issue o/y#10")).toHaveLength(1);
		expect(pulled(graph)).toEqual(["o/y#10 reach 1 holds me/served#1"]);
	});

	it("hold nothing on a closed one", async () => {
		const { graph } = await graphOf(
			{ 1: { body: "**Blocked on** o/y#10." } },
			{ issues: { "o/y#10": { state: "closed" } } },
		);
		expect(openBlockersOf(graph, 1)).toEqual([]);
	});

	it("read a bare number in a foreign body as that repo's", async () => {
		const { graph } = await graphOf(
			{ 1: { deps: ["o/y#10"] } },
			{ issues: { "o/y#10": { state: "open", body: "**Blocked on** #11." } } },
		);
		expect(pulled(graph)).toEqual(["o/y#11 reach 1 holds me/served#1"]);
	});
});

describe("proseOf: a served issue's markers as judged (#3277)", () => {
	it("judges this repo's, bare or `owner/name#n`, on the open list, and reads only another repo's", async () => {
		const { graph, reads } = await graphOf(
			{
				1: {
					body: "**Blocked on** o/y#11, #831, o/y#12, me/served#2 and o/y#10.",
				},
				2: {},
			},
			{
				issues: { "o/y#11": { state: "closed" } },
				failIssues: ["o/y#12"],
			},
		);
		expect(proseOf(graph, 1)).toEqual({
			named: ["#2", "#831", "o/y#10", "o/y#11", "o/y#12"],
			open: ["#2", "o/y#10"],
			closed: ["#831", "o/y#11"],
			unreadable: [{ ref: "o/y#12", error: "HTTP 404" }],
		});
		expect(reads.filter((r: string) => r.startsWith("issue me/"))).toEqual([]);
	});

	it("judges a marker a native edge also names, at no extra read", async () => {
		const { graph, reads } = await graphOf({
			1: { deps: ["o/y#10"], body: "**Blocked on** o/y#10." },
		});
		expect(proseOf(graph, 1).open).toEqual(["o/y#10"]);
		expect(openBlockersOf(graph, 1)).toEqual([
			{ label: "o/y#10", native: true },
		]);
		expect(reads.filter((r: string) => r === "issue o/y#10")).toEqual([]);
	});
});
