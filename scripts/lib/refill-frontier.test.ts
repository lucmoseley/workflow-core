// @vitest-environment node
/*
 * Pins how the refill loop's frontier takes in issues from repos it does not
 * serve (#2427): a foreign blocker pulled in by a served shortlist is read
 * from its own checkout's shortlist and launched, ranked on the served
 * issues it holds out; one with no checkout, or that its own shortlist does
 * not return, is held.
 * Driven through a fake shortlist, so no pick-next runs. Loosen a case and
 * the loop launches another repo's whole frontier, launches where no
 * checkout is, or leaves a served ticket held by a blocker nobody works.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { parseFailureLine, refillFrontier } = require("./refill-frontier.js");
const { blockerGraph, pulledInOf } = require("./blocker-graph.js");
const { decideTick } = require("./refill-decide.js");

let home: string;
let served: string;
let other: string;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "refill-frontier-"));
	served = path.join(home, "served");
	other = path.join(home, "other");
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const row = (number: number, over: Record<string, unknown> = {}) => ({
	number,
	bug: false,
	urgent: false,
	goal: false,
	stallDays: 0,
	asksQuestions: false,
	depth: 0,
	closes: 0,
	reach: 0,
	collision: "comment-only",
	takes: ["implement"],
	labels: ["takes:implement"],
	...over,
});

const pulled = (number: number, over: Record<string, unknown> = {}) => ({
	repo: "o/other",
	number,
	reach: 1,
	bug: false,
	urgent: false,
	goal: false,
	depth: 1,
	holds: ["o/served#1"],
	root: other,
	held: null,
	...over,
});

/** A fake shortlist answering per root, logging the roots it was asked for. */
const shortlists = (by: Record<string, unknown>) => {
	const asked: string[] = [];
	const fn = async (root: string) => {
		asked.push(root);
		const answer = by[root] as Record<string, unknown>;
		return "error" in answer ? answer : { pulledInUnread: [], ...answer };
	};
	return { fn, asked };
};

const NOW = Date.parse("2026-10-22T12:00:00Z");
const launchesOf = (frontier: unknown[]) =>
	(
		decideTick({
			now: NOW,
			startedAt: NOW - 3_600_000,
			stopRequested: false,
			frontier,
			retroBundles: [],
			running: [],
			freeSlots: 3,
			lastPromptAt: null,
			seats: [{ seat: "~/.claude2", week: 10, session: 10, fits: 9 }],
			history: [],
		}).launches ?? []
	).map(
		(l: { root: string; issues: number[] }) =>
			`${path.basename(l.root)}#${l.issues.join("+")}`,
	);

describe("a foreign blocker the served shortlist pulls in", () => {
	it("launches from its own checkout, the rest of that repo left out", async () => {
		const s = shortlists({
			[served]: { rows: [row(2)], retroBundles: [], pulledIn: [pulled(20)] },
			[other]: {
				rows: [row(20), row(21)],
				retroBundles: [{ prompt: "/retro", issues: [21] }],
				pulledIn: [],
				pulledInUnread: [],
			},
		});
		const m = await refillFrontier([served], {}, s.fn);
		expect(s.asked).toEqual([served, other]);
		expect(m.frontier.map((r: { number: number }) => r.number)).toEqual([
			20, 2,
		]);
		expect(m.retroBundles).toEqual([]);
		expect(launchesOf(m.frontier)).toContain("other#20");
	});

	it("ranks on the served issues it holds, not its own repo's reach", async () => {
		const s = shortlists({
			[served]: {
				rows: [row(2, { reach: 1 })],
				retroBundles: [],
				pulledIn: [
					pulled(20, { reach: 2, holds: ["o/served#1", "o/served#3"] }),
				],
			},
			[other]: {
				rows: [row(20, { reach: 9 })],
				retroBundles: [],
				pulledIn: [],
				pulledInUnread: [],
			},
		});
		const m = await refillFrontier([served], {}, s.fn);
		expect(
			m.frontier.find((r: { number: number }) => r.number === 20).reach,
		).toBe(2);
	});

	it("inherits the tier and chain depth of what it holds across repos, not its own repo's depth (#3222)", async () => {
		// o/other#20 holds an urgent served issue two steps on; the served #2
		// leads on reach, and #20's own repo counts it 7 deep on its own chains.
		const s = shortlists({
			[served]: {
				rows: [row(2, { reach: 3 })],
				retroBundles: [],
				pulledIn: [pulled(20, { urgent: true, depth: 2 })],
			},
			[other]: {
				rows: [row(20, { depth: 7 })],
				retroBundles: [],
				pulledIn: [],
				pulledInUnread: [],
			},
		});
		const m = await refillFrontier([served], {}, s.fn);
		expect(m.frontier.map((r: { number: number }) => r.number)).toEqual([
			20, 2,
		]);
		expect(m.frontier[0]).toMatchObject({ urgent: true, depth: 2, reach: 1 });
	});

	it("joins the tiers and keeps the deepest chain across the served repos that pull it in (#3222)", async () => {
		const third = path.join(home, "third");
		const s = shortlists({
			[served]: {
				rows: [],
				retroBundles: [],
				pulledIn: [pulled(20, { goal: true, depth: 3 })],
			},
			[third]: {
				rows: [],
				retroBundles: [],
				pulledIn: [pulled(20, { bug: true, urgent: true })],
			},
			[other]: {
				rows: [row(20)],
				retroBundles: [],
				pulledIn: [],
				pulledInUnread: [],
			},
		});
		const m = await refillFrontier([served, third], {}, s.fn);
		expect(m.frontier[0]).toMatchObject({
			bug: true,
			urgent: true,
			goal: true,
			depth: 3,
		});
	});

	it("is held, not launched, where its own shortlist leaves it out (#3285)", async () => {
		const s = shortlists({
			[served]: { rows: [], retroBundles: [], pulledIn: [pulled(20)] },
			[other]: { rows: [], retroBundles: [], pulledIn: [], pulledInUnread: [] },
		});
		const m = await refillFrontier([served], {}, s.fn);
		expect(m.frontier).toEqual([]);
		expect(m.held).toEqual([
			{
				ref: "o/other#20",
				why: "not on o/other's shortlist",
				holds: ["o/served#1"],
			},
		]);
	});

	it("is held where its served repo's shortlist leaves it out (#3285)", async () => {
		const s = shortlists({
			[served]: { rows: [], retroBundles: [], pulledIn: [pulled(20)] },
			[other]: { rows: [row(21)], retroBundles: [], pulledIn: [] },
		});
		const m = await refillFrontier([served, other], {}, s.fn);
		expect(m.frontier.map((r: { number: number }) => r.number)).toEqual([21]);
		expect(m.held.map((h: { ref: string }) => h.ref)).toEqual(["o/other#20"]);
	});

	it("adds its reach to the row where its repo is served already", async () => {
		const s = shortlists({
			[served]: { rows: [], retroBundles: [], pulledIn: [pulled(20)] },
			[other]: {
				rows: [row(20, { reach: 1 })],
				retroBundles: [],
				pulledIn: [],
				pulledInUnread: [],
			},
		});
		const m = await refillFrontier([served, other], {}, s.fn);
		expect(s.asked).toEqual([served, other]);
		expect(m.frontier.map((r: { reach: number }) => r.reach)).toEqual([2]);
		expect(m.held).toEqual([]);
	});

	it("sums its reach across the served repos that pull it in", async () => {
		const third = path.join(home, "third");
		const s = shortlists({
			[served]: { rows: [], retroBundles: [], pulledIn: [pulled(20)] },
			[third]: { rows: [], retroBundles: [], pulledIn: [pulled(20)] },
			[other]: {
				rows: [row(20)],
				retroBundles: [],
				pulledIn: [],
				pulledInUnread: [],
			},
		});
		const m = await refillFrontier([served, third], {}, s.fn);
		expect(s.asked.filter((r) => r === other)).toHaveLength(1);
		expect(m.frontier.map((r: { reach: number }) => r.reach)).toEqual([2]);
	});
});

describe("a pulled-in issue held outside the loop", () => {
	it("is reported with what it holds, never launched or read", async () => {
		const s = shortlists({
			[served]: {
				rows: [],
				retroBundles: [],
				pulledIn: [
					pulled(30, {
						repo: "o/far",
						root: null,
						held: "no checkout under /home tracks o/far",
					}),
				],
			},
		});
		const m = await refillFrontier([served], {}, s.fn);
		expect(s.asked).toEqual([served]);
		expect(m.frontier).toEqual([]);
		expect(m.held).toEqual([
			{
				ref: "o/far#30",
				why: "no checkout under /home tracks o/far",
				holds: ["o/served#1"],
			},
		]);
	});
});

describe("a pulled-in repo whose shortlist fails", () => {
	it("is reported failed and launches nothing from it", async () => {
		const s = shortlists({
			[served]: { rows: [row(2)], retroBundles: [], pulledIn: [pulled(20)] },
			[other]: { error: "exit 1" },
		});
		const m = await refillFrontier([served], {}, s.fn);
		expect(m.failed).toEqual([{ root: other, error: "exit 1" }]);
		expect(m.held).toEqual([]);
		expect(m.frontier.map((r: { number: number }) => r.number)).toEqual([2]);
	});
});

describe("a pulled-in issue whose own blockers would not read", () => {
	it("is reported held with what it holds, never launched", async () => {
		const s = shortlists({
			[served]: {
				rows: [],
				retroBundles: [],
				pulledIn: [],
				pulledInUnread: [
					{ ref: "o/other#20", error: "HTTP 502", holds: ["o/served#1"] },
				],
			},
		});
		const m = await refillFrontier([served], {}, s.fn);
		expect(m.frontier).toEqual([]);
		expect(m.held).toEqual([
			{
				ref: "o/other#20",
				why: "its blockers could not be read: HTTP 502",
				holds: ["o/served#1"],
			},
		]);
	});
});

describe("served X blocked by foreign Y, Y by foreign Z (#2427 acceptance)", () => {
	/** The served shortlist as pick-next builds it, over the chain's graph. */
	const servedShortlist = async (zState: "open" | "closed") => {
		const issue = (repo: string, number: number, state: string) => ({
			repo,
			number,
			state,
			title: `${repo}#${number}`,
			url: "",
			labels: [],
			body: "",
		});
		const deps: Record<string, unknown[]> = {
			"o/other#10": [issue("o/other", 20, zState)],
		};
		const graph = await blockerGraph(
			[{ number: 1, edges: [issue("o/other", 10, "open")], body: "" }],
			"o/served",
			{
				blockedBy: async (ref: { repo: string; number: number }) => ({
					ok: true,
					edges: deps[`${ref.repo}#${ref.number}`] ?? [],
				}),
				issue: async () => ({ ok: false, error: "unused" }),
				each: <T, R>(items: T[], fn: (item: T) => Promise<R>) =>
					Promise.all(items.map(fn)),
			},
		);
		const { rows, unread } = pulledInOf(graph);
		return {
			rows: [],
			retroBundles: [],
			pulledIn: rows.map((r: object) => ({ ...r, root: other, held: null })),
			pulledInUnread: unread,
		};
	};

	it("launches Z while Y is blocked, then Y once Z closes", async () => {
		const before = await refillFrontier(
			[served],
			{},
			shortlists({
				[served]: await servedShortlist("open"),
				[other]: { rows: [row(10), row(20)], retroBundles: [], pulledIn: [] },
			}).fn,
		);
		expect(launchesOf(before.frontier)).toEqual(["other#20"]);
		const after = await refillFrontier(
			[served],
			{},
			shortlists({
				[served]: await servedShortlist("closed"),
				[other]: { rows: [row(10)], retroBundles: [], pulledIn: [] },
			}).fn,
		);
		expect(launchesOf(after.frontier)).toEqual(["other#10"]);
	});
});

describe("a checkout whose shortlist timed out (#2677)", () => {
	it("is unread for the tick, while a healthy one still merges", async () => {
		const s = shortlists({
			[served]: { rows: [row(2)], retroBundles: [], pulledIn: [] },
			[other]: { error: "timed out after 300 s" },
		});
		const m = await refillFrontier([served, other], {}, s.fn);
		expect(m.failed).toEqual([{ root: other, error: "timed out after 300 s" }]);
		expect(m.frontier.map((r: { number: number }) => r.number)).toEqual([2]);
	});
});

describe("a checkout whose shortlist fails (#2561)", () => {
	it("idles the tick on that checkout and its reason, not on an empty frontier", async () => {
		const s = shortlists({ [served]: { error: "exited 1 FAILED: offline" } });
		const m = await refillFrontier([served], {}, s.fn);
		expect(
			decideTick({
				now: NOW,
				startedAt: NOW - 3_600_000,
				stopRequested: false,
				frontier: m.frontier,
				retroBundles: m.retroBundles,
				running: [],
				freeSlots: 3,
				lastPromptAt: null,
				seats: [{ seat: "~/.claude2", week: 10, session: 10, fits: 9 }],
				history: [],
				failedShortlists: m.failed,
			}),
		).toMatchObject({
			launches: [],
			idle: "shortlist failed in served: exited 1 FAILED: offline",
		});
	});

	it("keeps pick-next's FAILED: line over its closing line", () => {
		expect(
			parseFailureLine(
				"FAILED: could not list open issues (Could not resolve host: github.com).\n" +
					"        Check your connection.\n" +
					"        No shortlist produced — do not read this as an empty frontier.\n",
			),
		).toBe(
			"FAILED: could not list open issues (Could not resolve host: github.com).",
		);
		expect(parseFailureLine("boom\nlast line\n")).toBe("last line");
	});
});
