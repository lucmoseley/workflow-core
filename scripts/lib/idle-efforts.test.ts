/*
 * idle-efforts.test.ts — the idle alarm's core (#3641): which efforts count as
 * idle past 2 days, the lines per tracker, and the reading of GitHub's answer,
 * driven through findIdleEfforts, buildIdleLines and parseIssueNodes from
 * plain readings, since the core is pure. A break here either strands an
 * effort unreported or names one that is moving, which teaches the founder to ignore it.
 */

import { describe, expect, it } from "vitest";

const {
	IDLE_DAYS,
	buildIdleLines,
	findIdleEfforts,
	parseIssueNodes,
	selectUnseen,
} = require("./idle-efforts.js");

const NOW = Date.parse("2026-10-29T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const IDLE_MS = IDLE_DAYS * DAY;
const REPO = "o/core";
const OTHER = "o/product";

const issue = (number: number, over: Record<string, unknown> = {}) => ({
	number,
	title: `issue ${number}`,
	createdAt: NOW - 10 * DAY,
	labels: ["takes:implement"],
	blocked: false,
	gated: false,
	children: [],
	...over,
});

const tracker = (
	issues: ReturnType<typeof issue>[],
	over: Record<string, unknown> = {},
) => ({ repo: REPO, served: true, issues, error: null, ...over });

const findings = (
	trackers: ReturnType<typeof tracker>[],
	launches: Record<string, number> = {},
	running: string[] = [],
) =>
	findIdleEfforts({
		trackers,
		launches: new Map(Object.entries(launches)),
		running: new Set(running),
		now: NOW,
	});

const idleNumbers = (
	trackers: ReturnType<typeof tracker>[],
	launches: Record<string, number> = {},
	running: string[] = [],
) =>
	findings(trackers, launches, running)[0].idle.map(
		(i: { number: number }) => i.number,
	);

const container = (number: number, ...children: number[]) =>
	issue(number, {
		labels: ["takes:children"],
		children: children.map((n) => ({ repo: REPO, number: n })),
	});

describe("findIdleEfforts", () => {
	it("holds the 2-day boundary on both sides, a never-launched issue ageing from creation", () => {
		const t = tracker([
			issue(1, { createdAt: NOW - IDLE_MS }),
			issue(2, { createdAt: NOW - IDLE_MS - 1 }),
		]);
		expect(idleNumbers([t])).toEqual([2]);
	});

	it("ages a launched issue from its last launch", () => {
		const t = tracker([issue(1), issue(2)]);
		expect(
			idleNumbers([t], {
				"o/core#1": NOW - IDLE_MS + 1,
				"o/core#2": NOW - IDLE_MS - 1,
			}),
		).toEqual([2]);
	});

	it("freshens a container from a descendant's launch, a closed one in another repo included", () => {
		const t = tracker([
			container(1, 2),
			issue(2, {
				labels: ["takes:children"],
				children: [{ repo: OTHER, number: 9 }],
			}),
		]);
		expect(idleNumbers([t], { "o/product#9": NOW - DAY })).toEqual([]);
	});

	it("counts a container whose child is running as not idle, however old the launch", () => {
		const t = tracker([container(1, 2), issue(2)]);
		const old = { "o/core#2": NOW - 5 * DAY };
		expect(idleNumbers([t], old, ["o/core#2"])).toEqual([]);
		expect(idleNumbers([t], old)).toEqual([2]);
	});

	it("leaves out blocked, gated, takes:human and parked issues", () => {
		const t = tracker([
			issue(1, { blocked: true }),
			issue(2, { gated: true }),
			issue(3, { labels: ["takes:human"] }),
			issue(4, { labels: ["takes:implement", "parked"] }),
			issue(5),
		]);
		expect(idleNumbers([t])).toEqual([5]);
	});

	it("leaves out a container every open child of which waits, which pick-next never launches", () => {
		const t = tracker([
			container(1, 2, 3),
			issue(2, { blocked: true }),
			issue(3, { labels: ["takes:human"] }),
		]);
		expect(idleNumbers([t])).toEqual([]);
	});

	it("counts a stranding once, at its deepest idle issue, not again at each ancestor", () => {
		const t = tracker([container(1, 2), container(2, 3), issue(3)]);
		expect(idleNumbers([t])).toEqual([3]);
	});

	it("orders a tracker's idle efforts oldest first", () => {
		const t = tracker([
			issue(1, { createdAt: NOW - 3 * DAY }),
			issue(2, { createdAt: NOW - 7 * DAY }),
		]);
		expect(idleNumbers([t])).toEqual([2, 1]);
	});

	it.each([
		[["takes:implement"], null],
		[["takes:children"], "takes:children"],
		[["takes:implement", "waiting:external"], "waiting:external"],
		[[], "takes:none"],
	])("gives labels %j the launch filter's skip reason %s", (labels, why) => {
		expect(findings([tracker([issue(1, { labels })])])[0].idle[0].skip).toBe(
			why,
		);
	});
});

describe("buildIdleLines", () => {
	it("gives one line per tracker, naming the oldest and its skip reason", () => {
		const lines = buildIdleLines(
			findings([
				tracker([
					issue(1, { createdAt: NOW - 3 * DAY }),
					issue(2, {
						createdAt: NOW - 5 * DAY,
						labels: ["takes:implement", "waiting:external"],
					}),
				]),
				tracker([], { repo: "o/quiet" }),
			]),
			true,
		);
		expect(lines).toEqual([
			"o/core: 2 idle past 2 days; oldest #2 (issue 2), idle 5.0 days; skip reason: waiting:external",
			"o/quiet: none idle past 2 days",
		]);
	});

	it("names each urgent idle issue beneath a tracker the loop does not serve", () => {
		const lines = buildIdleLines(
			findings([
				tracker(
					[
						issue(1, { createdAt: NOW - 9 * DAY }),
						issue(2, { labels: ["takes:implement", "urgent"] }),
						issue(3, { labels: ["takes:implement", "urgent"], blocked: true }),
					],
					{ repo: OTHER, served: false },
				),
			]),
			true,
		);
		expect(lines).toEqual([
			"o/product: 2 idle past 2 days (the refill loop does not serve it); oldest #2 (issue 2), idle 10.0 days; skip reason: none, the launch filter passes it",
			"  urgent #2 (issue 2), idle 10.0 days",
		]);
	});

	it("says first where no loop runs, so the unserved trackers are not read as out of scope", () => {
		const lines = buildIdleLines(
			findings([tracker([], { served: false })]),
			false,
		);
		expect(lines).toEqual([
			"The refill loop is not running, so it serves no tracker.",
			"o/core: none idle past 2 days (the refill loop does not serve it)",
		]);
	});

	it("names a tracker that would not read, never as none idle", () => {
		const lines = buildIdleLines(
			findings([tracker([], { error: "HTTP 502" })]),
			true,
		);
		expect(lines).toEqual(["o/core: unread — HTTP 502"]);
	});
});

describe("parseIssueNodes", () => {
	const node = (over: Record<string, unknown> = {}) => ({
		number: 7,
		title: "t",
		createdAt: "2026-10-20T00:00:00Z",
		body: "",
		labels: { nodes: [{ name: "takes:implement" }] },
		blockedBy: { totalCount: 0, nodes: [] },
		subIssues: { nodes: [] },
		...over,
	});
	const parse = (...nodes: unknown[]) =>
		parseIssueNodes([{ data: { repository: { issues: { nodes } } } }], NOW);

	it("reads an issue's labels, creation and sub-issues, other repos' included", () => {
		const [i] = parse(
			node({
				subIssues: {
					nodes: [
						{
							number: 9,
							state: "CLOSED",
							repository: { nameWithOwner: OTHER },
						},
					],
				},
			}),
		);
		expect(i).toEqual({
			number: 7,
			title: "t",
			createdAt: Date.parse("2026-10-20T00:00:00Z"),
			labels: ["takes:implement"],
			blocked: false,
			gated: false,
			children: [{ repo: OTHER, number: 9 }],
		});
	});

	it("reads an open blocker, or a list longer than the query reads, as blocked; a closed one as not", () => {
		const blocked = (blockedBy: unknown) =>
			parse(node({ blockedBy }))[0].blocked;
		expect(blocked({ totalCount: 1, nodes: [{ state: "OPEN" }] })).toBe(true);
		expect(blocked({ totalCount: 26, nodes: [] })).toBe(true);
		expect(blocked({ totalCount: 1, nodes: [{ state: "CLOSED" }] })).toBe(
			false,
		);
	});

	it("reads a date gate still ahead as gated, and one passed as not", () => {
		const gated = (date: string) =>
			parse(node({ body: `**Gated until:** ${date}` }))[0].gated;
		expect(gated("2026-12-01")).toBe(true);
		expect(gated("2026-10-01")).toBe(false);
	});

	it("throws on a page that names no issues, never reading it as none", () => {
		expect(() => parseIssueNodes([{ data: null }], NOW)).toThrow(
			"named no issues",
		);
	});
});

describe("selectUnseen", () => {
	const idle = (number: number) => ({
		number,
		title: `issue ${number}`,
		idleMs: 3 * DAY,
		urgent: false,
		skip: null,
	});
	const finding = (
		repo: string,
		numbers: number[],
		error: string | null = null,
	) => ({
		repo,
		served: true,
		error,
		idle: numbers.map(idle),
	});
	const stamp = (day: string, seen: unknown) => JSON.stringify({ day, seen });

	it("names every finding with no stamp, and signs them for the day", () => {
		const both = [finding("o/a", [1]), finding("o/b", [])];
		const { unseen, signature } = selectUnseen(both, null, "2026-10-29");
		expect(unseen.map((f: { repo: string }) => f.repo)).toEqual(["o/a"]);
		expect(signature).toBe(stamp("2026-10-29", ["o/a#1"]));
	});

	it("names nothing delivered the same day, and signs nothing", () => {
		expect(
			selectUnseen(
				[finding("o/a", [1])],
				stamp("2026-10-29", ["o/a#1"]),
				"2026-10-29",
			),
		).toEqual({ unseen: [], signature: null });
	});

	it("names a tracker whole once it holds a finding undelivered that day", () => {
		const { unseen, signature } = selectUnseen(
			[finding("o/a", [1, 2])],
			stamp("2026-10-29", ["o/a#1"]),
			"2026-10-29",
		);
		expect(unseen[0]?.idle.map((i: { number: number }) => i.number)).toEqual([
			1, 2,
		]);
		expect(signature).toBe(stamp("2026-10-29", ["o/a#1", "o/a#2"]));
	});

	it("names a finding again the next day, and an unread tracker once a day", () => {
		const unread = finding("o/A", [], "HTTP 502");
		const day1 = selectUnseen([unread], null, "2026-10-29");
		expect(day1.signature).toBe(stamp("2026-10-29", ["o/a unread"]));
		expect(selectUnseen([unread], day1.signature, "2026-10-29").unseen).toEqual(
			[],
		);
		expect(selectUnseen([unread], day1.signature, "2026-10-30").unseen).toEqual(
			[unread],
		);
	});

	it("reads a damaged stamp, or its entries that are no key, as none", () => {
		const one = [finding("o/a", [1])];
		expect(selectUnseen(one, "{torn", "2026-10-29").unseen).toHaveLength(1);
		expect(
			selectUnseen(one, stamp("2026-10-29", "x"), "2026-10-29").unseen,
		).toHaveLength(1);
		expect(
			selectUnseen(one, stamp("2026-10-29", [1]), "2026-10-29").signature,
		).toBe(stamp("2026-10-29", ["o/a#1"]));
	});
});
