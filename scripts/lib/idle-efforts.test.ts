/*
 * idle-efforts.test.ts — the idle alarm's core (#3641): which efforts count as
 * idle past 2 days, the lines per tracker, and the reading of GitHub's answer,
 * driven through buildReadings, findIdleEfforts, buildIdleLines, buildIdleReport,
 * buildFindingRecords and parseIssueNodes from plain readings, since the core is
 * pure. A break here either strands an
 * effort unreported or names one that is moving, which teaches the founder to ignore it.
 */

import { describe, expect, it } from "vitest";

const {
	IDLE_DAYS,
	buildIdleLines,
	buildIdleReport,
	buildReadings,
	findIdleEfforts,
	buildFindingRecords,
	parseIssueNodes,
} = require("./idle-efforts.js");
const { PROBE_HELD, buildLimitCapHoldWhy } = require("./refill-decide.js");

/** The cap refill-decide.js keeps to itself, pinned here. */
const LIMIT_PARK_CAP = 2;

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
) => ({
	repo: REPO,
	served: true,
	probeHeld: false,
	issues,
	error: null,
	...over,
});

const findings = (
	trackers: ReturnType<typeof tracker>[],
	launches: Record<string, number> = {},
	running: string[] = [],
	holds: Record<
		string,
		{ why: string; since: number; atCap?: boolean; onLimit?: boolean }
	> = {},
) =>
	findIdleEfforts({
		trackers,
		launches: new Map(Object.entries(launches)),
		running: new Set(running),
		holds: new Map(Object.entries(holds)),
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

	it("counts a parked issue the loop holds on a full seat past 2 days from the hold's start, naming the hold (#3680)", () => {
		const parked = { labels: ["takes:implement", "parked"] };
		const t = tracker([issue(1, parked), issue(2, parked), issue(3, parked)]);
		const why = "parked: its session's seat /s2 is full";
		const launched = NOW - 5 * DAY;
		const idle = findings(
			[t],
			{ "o/core#1": launched, "o/core#2": launched, "o/core#3": launched },
			[],
			{
				"o/core#1": { why, since: NOW - 3 * DAY },
				"o/core#2": { why, since: NOW - IDLE_MS },
			},
		)[0].idle;
		expect(
			idle.map((i: { number: number; skip: string; idleMs: number }) => [
				i.number,
				i.skip,
				i.idleMs,
			]),
		).toEqual([[1, why, 3 * DAY]]);
	});

	it("counts a held issue whose open children all wait (#3838)", () => {
		const held = { why: "stopped on its limit", since: NOW - 5 * DAY };
		const t = tracker([container(1, 2), issue(2, { blocked: true })]);
		expect(
			findings([t], {}, [], { "o/core#1": held })[0].idle.map(
				(i: { number: number }) => i.number,
			),
		).toEqual([1]);
	});

	it("names a launch held stopped on its limit past 2 days, aged from the stop (#3838)", () => {
		const why = "stopped on its weekly limit (reset unread)";
		const [{ idle }] = findings(
			[tracker([issue(1), issue(2), issue(3)])],
			{ "o/core#1": NOW - 9 * DAY, "o/core#2": NOW - 9 * DAY },
			[],
			{
				"o/core#1": { why, since: NOW - 5 * DAY },
				"o/core#2": { why, since: NOW - IDLE_MS },
				"o/core#3": { why, since: NOW - DAY },
			},
		);
		expect(
			idle.map((i: { number: number; skip: string; idleMs: number }) => [
				i.number,
				i.skip,
				i.idleMs,
			]),
		).toEqual([[1, why, 5 * DAY]]);
	});

	it("reads a hold under 2 days as its container's activity, so an old launch beneath it does not name the container (#3838)", () => {
		const held = { why: "stopped on its limit", since: NOW - DAY };
		const launched = { "o/core#2": NOW - 5 * DAY };
		const t = tracker([container(1, 2), issue(2)]);
		expect(findings([t], launched, [], { "o/core#2": held })[0].idle).toEqual(
			[],
		);
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
	const top = (text: string) => ({ text, nested: false });

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
			[],
		);
		expect(lines).toEqual([
			top(
				"o/core: 2 idle past 2 days; oldest #2 (issue 2), idle 5.0 days; skip reason: waiting:external",
			),
			top("o/quiet: none idle past 2 days"),
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
			[],
		);
		expect(lines).toEqual([
			top(
				"o/product: 2 idle past 2 days (the refill loop does not serve it); oldest #2 (issue 2), idle 10.0 days; skip reason: none, the launch filter passes it",
			),
			{ text: "urgent #2 (issue 2), idle 10.0 days", nested: true },
		]);
	});

	it("names a launch held on its limit beneath the line though an older issue is the oldest (#3838)", () => {
		const why = "stopped on its weekly limit (reset Fri)";
		const lines = buildIdleLines(
			findings([tracker([issue(1), issue(2)])], {}, [], {
				"o/core#2": { why, since: NOW - 3 * DAY, onLimit: true },
			}),
			true,
			[],
		);
		expect(lines).toEqual([
			top(
				"o/core: 2 idle past 2 days; oldest #1 (issue 1), idle 10.0 days; skip reason: none, the launch filter passes it, so it waits on rank",
			),
			{
				text: `held #2 (issue 2), idle 3.0 days; skip reason: ${why}`,
				nested: true,
			},
		]);
	});

	describe("a tracker under a probe hold (#3898)", () => {
		const held = { probeHeld: true };

		it("names the hold, not rank, for a row the launch filter passes", () => {
			const [line] = buildIdleLines(
				findings([tracker([issue(1)], held)]),
				true,
				[],
			);
			expect(line.text).toContain(`skip reason: ${PROBE_HELD}`);
			expect(line.text).not.toContain("rank");
		});

		it("names the hold for a row the launch filter skips, as the loop checks it first", () => {
			const [only] = findings([tracker([issue(1, { labels: [] })], held)])[0]
				.idle;
			expect(only.skip).toBe(PROBE_HELD);
		});

		it("names it over a row's own hold, as the loop checks it first", () => {
			const [only] = findings(
				[tracker([issue(1, { labels: ["takes:implement", "parked"] })], held)],
				{},
				[],
				{ "o/core#1": { why: "the cap's why", since: NOW - 3 * DAY } },
			)[0].idle;
			expect(only.skip).toBe(PROBE_HELD);
		});
	});

	describe("a ticket held at the limit-cap parks' cap (#3809)", () => {
		const parked = { labels: ["takes:implement", "parked"] };
		const capWhy = "the cap's why";
		const hold = (over: Record<string, unknown> = {}) => ({
			why: capWhy,
			since: NOW - 3 * DAY,
			atCap: true,
			...over,
		});

		it("names it beneath the line though an older issue is the oldest", () => {
			const lines = buildIdleLines(
				findings([tracker([issue(1), issue(2, parked)])], {}, [], {
					"o/core#2": hold(),
				}),
				true,
				[],
			);
			expect(lines).toEqual([
				top(
					"o/core: 2 idle past 2 days; oldest #1 (issue 1), idle 10.0 days; skip reason: none, the launch filter passes it, so it waits on rank",
				),
				{
					text: `held #2 (issue 2), idle 3.0 days; skip reason: ${capWhy}`,
					nested: true,
				},
			]);
		});

		it("names it once where it is the oldest", () => {
			const lines = buildIdleLines(
				findings([tracker([issue(2, parked)])], {}, [], {
					"o/core#2": hold(),
				}),
				true,
				[],
			);
			expect(lines).toEqual([
				top(
					`o/core: 1 idle past 2 days; oldest #2 (issue 2), idle 3.0 days; skip reason: ${capWhy}`,
				),
			]);
		});

		it("does not name it before its hold is 2 days old", () => {
			const lines = buildIdleLines(
				findings([tracker([issue(1), issue(2, parked)])], {}, [], {
					"o/core#2": hold({ since: NOW - IDLE_MS }),
				}),
				true,
				[],
			);
			expect(lines).toHaveLength(1);
			expect(lines[0].text).toMatch(/^o\/core: 1 idle /);
		});

		it("leaves a full seat's hold, which ends with the seat's reset, in the count", () => {
			const lines = buildIdleLines(
				findings([tracker([issue(1), issue(2, parked)])], {}, [], {
					"o/core#2": hold({ why: "seat full", atCap: undefined }),
				}),
				true,
				[],
			);
			expect(lines).toHaveLength(1);
			expect(lines[0].text).toMatch(/^o\/core: 2 idle /);
		});
	});

	it("says first where no loop runs, so the unserved trackers are not read as out of scope", () => {
		const lines = buildIdleLines(
			findings([tracker([], { served: false })]),
			false,
			[],
		);
		expect(lines).toEqual([
			top(
				"The refill loop is not running, so it serves no tracker. /pick-next restarts it.",
			),
			top("o/core: none idle past 2 days (the refill loop does not serve it)"),
		]);
	});

	it("names a tracker that would not read, never as none idle", () => {
		const lines = buildIdleLines(
			findings([tracker([], { error: "HTTP 502" })]),
			true,
			[],
		);
		expect(lines).toEqual([top("o/core: unread — HTTP 502")]);
	});
});

describe("buildFindingRecords", () => {
	it("puts a named stop's record ahead of the trackers' (#3892)", () => {
		const f = findings([tracker([issue(1)])]);
		expect(
			buildFindingRecords(f, true, []).map((r: { code: string }) => r.code),
		).toEqual(["REFILL-LOOP-NOT-RUNNING", "IDLE-EFFORTS"]);
	});

	it("gives an unread tracker IDLE-EFFORTS-UNREAD and one with idle efforts IDLE-EFFORTS, a quiet one none", () => {
		const f = findings([
			tracker([], { error: "HTTP 502" }),
			tracker([issue(1)], { repo: OTHER }),
			tracker([], { repo: "o/quiet" }),
		]);
		expect(buildFindingRecords(f, false, [])).toEqual([
			{ code: "IDLE-EFFORTS-UNREAD", text: "o/core would not read: HTTP 502" },
			{
				code: "IDLE-EFFORTS",
				text: "o/product: 1 effort(s) idle past 2 days",
				data: { repo: OTHER, idle: f[1].idle },
			},
		]);
	});
});

describe("buildReadings", () => {
	const ledger = (
		root: string,
		launchTimes: [number, number][] = [],
		recent: number[][] = [],
	) => ({ root, launchTimes: new Map(launchTimes), recent });
	const read = (
		trackers: Record<string, unknown>[],
		loop: Record<string, unknown> = {},
	) =>
		buildReadings({
			rootsOf: new Map([
				[REPO, ["/r/core", "/r/core2"]],
				[OTHER, ["/r/product"]],
			]),
			trackers: trackers.map((t) => ({
				issues: [],
				error: null,
				ledgers: [],
				markers: [],
				...t,
			})),
			loop: {
				served: [],
				launches: [],
				held: [],
				repoHolds: [],
				holdsUnreadRoots: [],
				...loop,
			},
			now: NOW,
		});

	it("joins each checkout's ledger to its tracker, keeping each issue's latest launch", () => {
		const r = read([
			{
				repo: REPO,
				ledgers: [
					ledger("/r/core", [[1, NOW - 3 * DAY]], [[2]]),
					ledger("/r/core2", [[1, NOW - DAY]]),
				],
			},
			{ repo: OTHER, ledgers: [ledger("/r/product", [[1, NOW - 5 * DAY]])] },
		]);
		expect(r.launches).toEqual(
			new Map([
				[`${REPO}#1`, NOW - DAY],
				[`${OTHER}#1`, NOW - 5 * DAY],
			]),
		);
		expect([...r.running]).toEqual([`${REPO}#2`]);
	});

	it("joins the loop's running launches and holds from checkout to tracker", () => {
		const r = read([{ repo: REPO }, { repo: OTHER }], {
			launches: [{ root: "/r/product", issues: [4, 5] }],
			held: [{ root: "/r/core2", number: 6, why: "seat full", since: NOW }],
		});
		expect([...r.running]).toEqual([`${OTHER}#4`, `${OTHER}#5`]);
		expect(r.holds).toEqual(
			new Map([[`${REPO}#6`, { why: "seat full", since: NOW }]]),
		);
	});

	describe("a hold at the limit-cap parks' cap, read from its marker (#3840)", () => {
		const parkedIssue = issue(7, { labels: ["takes:implement", "parked"] });
		const buildCapMarker = (writtenAt: number) => ({
			issues: [7],
			writtenAt,
			limitParks: LIMIT_PARK_CAP,
		});
		const idleOf = (issues: object[], markers: object[], held: object[] = []) =>
			findIdleEfforts(
				read([{ repo: REPO, issues, markers: [markers] }], { held }),
			)[0].idle;

		it("names it past 2 days of hold with the loop holding nothing, the marker's write being its start", () => {
			const [only, ...rest] = idleOf(
				[parkedIssue],
				[buildCapMarker(NOW - 3 * DAY)],
			);
			expect(rest).toEqual([]);
			expect(only).toMatchObject({
				number: 7,
				heldAtCap: true,
				idleMs: 3 * DAY,
				skip: buildLimitCapHoldWhy(LIMIT_PARK_CAP),
			});
		});

		it("leaves out one held under 2 days", () => {
			expect(idleOf([parkedIssue], [buildCapMarker(NOW - DAY)])).toEqual([]);
		});

		it("takes its start from the marker over a later one in the loop's state", () => {
			const [only] = idleOf(
				[parkedIssue],
				[buildCapMarker(NOW - 3 * DAY)],
				[{ root: "/r/core", number: 7, why: "seat full", since: NOW - DAY }],
			);
			expect(only).toMatchObject({ heldAtCap: true, idleMs: 3 * DAY });
		});

		it("still excludes a parked question, its marker holding no count", () => {
			const question = { issues: [7], writtenAt: NOW - 3 * DAY };
			expect(idleOf([parkedIssue], [question])).toEqual([]);
		});

		it("still excludes a parked ticket under the cap", () => {
			const under = {
				...buildCapMarker(NOW - 3 * DAY),
				limitParks: LIMIT_PARK_CAP - 1,
			};
			expect(idleOf([parkedIssue], [under])).toEqual([]);
		});

		it("reads the newest marker listing it, so a later question park ends the hold", () => {
			const question = { issues: [7], writtenAt: NOW - 3 * DAY };
			expect(
				idleOf([parkedIssue], [buildCapMarker(NOW - 5 * DAY), question]),
			).toEqual([]);
		});

		it("holds it where any one checkout's newest marker is at the cap, as the loop routes per checkout", () => {
			const question = { issues: [7], writtenAt: NOW - DAY };
			const [only] = findIdleEfforts(
				read([
					{
						repo: REPO,
						issues: [parkedIssue],
						markers: [[buildCapMarker(NOW - 3 * DAY)], [question]],
					},
				]),
			)[0].idle;
			expect(only).toMatchObject({ heldAtCap: true, idleMs: 3 * DAY });
		});

		it("reads no hold once the label is off, the marker left behind", () => {
			const [only] = idleOf(
				[issue(7, { labels: ["takes:implement"] })],
				[buildCapMarker(NOW - 3 * DAY)],
			);
			expect(only).toMatchObject({ heldAtCap: false, skip: null });
		});
	});

	it("marks a tracker served where the loop serves any of its checkouts", () => {
		const r = read([{ repo: REPO }, { repo: OTHER, error: "HTTP 502" }], {
			served: ["/r/core2"],
		});
		expect(r.trackers).toEqual([
			{
				repo: REPO,
				served: true,
				probeHeld: false,
				holdsUnread: false,
				issues: [],
				error: null,
			},
			{
				repo: OTHER,
				served: false,
				probeHeld: false,
				holdsUnread: false,
				issues: [],
				error: "HTTP 502",
			},
		]);
	});

	describe("a tracker's unread hold stores (#3918)", () => {
		const holdsUnread = (loop: Record<string, unknown>) =>
			read([{ repo: REPO }], loop).trackers[0].holdsUnread;

		it("reads so where every served checkout's store is unread", () => {
			expect(
				holdsUnread({
					served: ["/r/core", "/r/core2"],
					holdsUnreadRoots: ["/r/core", "/r/core2"],
				}),
			).toBe(true);
		});

		it("does not read so where another served checkout reads free", () => {
			expect(
				holdsUnread({
					served: ["/r/core", "/r/core2"],
					holdsUnreadRoots: ["/r/core"],
				}),
			).toBe(false);
		});

		it("does not read so on a tracker the loop does not serve", () => {
			expect(holdsUnread({ served: [], holdsUnreadRoots: [] })).toBe(false);
		});
	});

	describe("a tracker's probe hold (#3898)", () => {
		const probeHeld = (loop: Record<string, unknown>) =>
			read([{ repo: REPO }], loop).trackers[0].probeHeld;

		it("holds a tracker whose only served checkout has one", () => {
			expect(
				probeHeld({
					served: ["/r/core"],
					repoHolds: [{ root: "/r/core", kind: "probe" }],
				}),
			).toBe(true);
		});

		it("does not hold a tracker the loop still serves through another checkout", () => {
			expect(
				probeHeld({
					served: ["/r/core", "/r/core2"],
					repoHolds: [{ root: "/r/core", kind: "probe" }],
				}),
			).toBe(false);
		});

		it("holds no tracker on a park hold, which stops no launch", () => {
			expect(
				probeHeld({
					served: ["/r/core"],
					repoHolds: [{ root: "/r/core", kind: "park" }],
				}),
			).toBe(false);
		});

		it("holds no tracker the loop does not serve", () => {
			expect(
				probeHeld({
					served: ["/r/product"],
					repoHolds: [{ root: "/r/core", kind: "probe" }],
				}),
			).toBe(false);
		});
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

describe("buildIdleReport", () => {
	/** A session start not held; a null `deliveredStamp` is a day's first. */
	const NothingNamed = {
		unseen: [],
		stopUnseen: false,
		damagedUnseen: [],
		lines: [],
		signature: null,
		stampNow: null,
	};
	const reportAtStart = (
		trackerFindings: unknown[],
		deliveredStamp: string | null,
		day: string,
	) =>
		buildIdleReport(trackerFindings, true, [], {
			stamp: deliveredStamp,
			day,
			held: false,
			stoppedRun: null,
		});

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

	const unservedUrgent = {
		...finding("o/a", []),
		served: false,
		idle: [{ ...idle(1), urgent: true }],
	};

	it("gives a nested line its indent", () => {
		const { lines } = buildIdleReport([unservedUrgent], true, [], null);
		expect(lines).toHaveLength(2);
		expect(lines[1]).toMatch(/^ {2}urgent /);
	});

	it("names everything and stamps nothing on a plain run", () => {
		expect(buildIdleReport([unservedUrgent], true, [], null)).toMatchObject({
			unseen: [unservedUrgent],
			signature: null,
			stampNow: null,
		});
	});

	it("stamps what it names at a start not held", () => {
		const { signature, stampNow } = reportAtStart(
			[unservedUrgent],
			null,
			"2026-10-29",
		);
		expect(signature).not.toBeNull();
		expect(stampNow).toBe(signature);
	});

	it("carries the signature but stamps nothing at a held start", () => {
		const { signature, stampNow } = buildIdleReport(
			[unservedUrgent],
			true,
			[],
			{
				stamp: null,
				day: "2026-10-29",
				held: true,
				stoppedRun: null,
			},
		);
		expect(signature).not.toBeNull();
		expect(stampNow).toBeNull();
	});

	describe("a stopped loop, a finding of its own (#3892)", () => {
		const stopLine =
			"The refill loop is not running, so it serves no tracker. /pick-next restarts it.";
		const stopKey = "refill-loop stopped 5";
		const stoppedAtStart = (
			trackerFindings: unknown[],
			deliveredStamp: string | null,
			day: string,
			{ held = false, stoppedRun = 5 as number | null } = {},
		) =>
			buildIdleReport(trackerFindings, false, [], {
				stamp: deliveredStamp,
				day,
				held,
				stoppedRun,
			});

		it("names and stamps it with nothing idle on any tracker", () => {
			const report = stoppedAtStart([finding("o/a", [])], null, "2026-10-29");
			expect(report).toMatchObject({
				unseen: [],
				stopUnseen: true,
				lines: [stopLine],
			});
			expect(report.stampNow).toBe(stamp("2026-10-29", [stopKey]));
		});

		it("names it where the day's rows were all shown, keeping their record", () => {
			const report = stoppedAtStart(
				[finding("o/a", [1])],
				stamp("2026-10-29", ["o/a#1"]),
				"2026-10-29",
			);
			expect(report).toMatchObject({ unseen: [], lines: [stopLine] });
			expect(report.stampNow).toBe(stamp("2026-10-29", ["o/a#1", stopKey]));
		});

		it("names nothing once it is recorded that day, and again the next day", () => {
			const { signature } = stoppedAtStart(
				[unservedUrgent],
				null,
				"2026-10-29",
			);
			expect(stoppedAtStart([unservedUrgent], signature, "2026-10-29")).toEqual(
				NothingNamed,
			);
			expect(
				stoppedAtStart([finding("o/a", [])], signature, "2026-10-30").lines,
			).toEqual([stopLine]);
		});

		it("names a later run's stop the same day", () => {
			const { signature } = stoppedAtStart([], null, "2026-10-29");
			expect(
				stoppedAtStart([], signature, "2026-10-29", { stoppedRun: 6 }).lines,
			).toEqual([stopLine]);
		});

		it("leaves its line off a new row's report once recorded that day", () => {
			const report = stoppedAtStart(
				[finding("o/a", [1])],
				stamp("2026-10-29", [stopKey]),
				"2026-10-29",
			);
			expect(report.stopUnseen).toBe(false);
			expect(report.lines).not.toContain(stopLine);
			expect(report.stampNow).toBe(stamp("2026-10-29", [stopKey, "o/a#1"]));
		});

		it("carries the signature but stamps nothing at a held start", () => {
			const report = stoppedAtStart([], null, "2026-10-29", { held: true });
			expect(report.lines).toEqual([stopLine]);
			expect(report.signature).not.toBeNull();
			expect(report.stampNow).toBeNull();
		});

		it("is no finding of a live loop", () => {
			expect(reportAtStart([finding("o/a", [])], null, "2026-10-29")).toEqual(
				NothingNamed,
			);
		});

		it("names it on a plain run with no tracker, recording nothing", () => {
			expect(buildIdleReport([], false, [], null)).toMatchObject({
				stopUnseen: true,
				lines: [stopLine],
				signature: null,
				stampNow: null,
			});
		});
	});

	describe("a damaged file (#3918)", () => {
		const noticeOn = (delivered: string | null) => ({
			stamp: delivered,
			day: "2026-10-29",
			held: false,
			stoppedRun: null,
		});

		it("names it above the trackers, and only an unseen one the same day", () => {
			const first = buildIdleReport(
				[finding("o/a", [])],
				true,
				["/r/state is damaged (x)"],
				noticeOn(null),
			);
			expect(first.lines[0]).toBe(
				"Refill loop file damaged: /r/state is damaged (x)",
			);
			expect(first.stampNow).not.toBeNull();

			expect(
				buildIdleReport(
					[],
					true,
					["/r/state is damaged (x)"],
					noticeOn(first.signature),
				),
			).toEqual(NothingNamed);

			expect(
				buildIdleReport(
					[],
					true,
					["/r/state is damaged (x)", "/r/control is damaged (y)"],
					noticeOn(first.signature),
				).damagedUnseen,
			).toEqual(["/r/control is damaged (y)"]);
		});

		it("gives a record of its own per file", () => {
			expect(buildFindingRecords([], false, ["/r/a"])).toEqual([
				{
					code: "REFILL-LOOP-FILE-DAMAGED",
					text: "Refill loop file damaged: /r/a",
				},
			]);
		});
	});

	it("names every finding with no stamp, and signs them for the day", () => {
		const both = [finding("o/a", [1]), finding("o/b", [])];
		const { unseen, signature } = reportAtStart(both, null, "2026-10-29");
		expect(unseen.map((f: { repo: string }) => f.repo)).toEqual(["o/a"]);
		expect(signature).toBe(stamp("2026-10-29", ["o/a#1"]));
	});

	it("names nothing delivered the same day, and signs nothing", () => {
		expect(
			reportAtStart(
				[finding("o/a", [1])],
				stamp("2026-10-29", ["o/a#1"]),
				"2026-10-29",
			),
		).toEqual(NothingNamed);
	});

	it("names a tracker whole once it holds a finding undelivered that day", () => {
		const { unseen, signature } = reportAtStart(
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
		const day1 = reportAtStart([unread], null, "2026-10-29");
		expect(day1.signature).toBe(stamp("2026-10-29", ["o/a unread"]));
		expect(
			reportAtStart([unread], day1.signature, "2026-10-29").unseen,
		).toEqual([]);
		expect(
			reportAtStart([unread], day1.signature, "2026-10-30").unseen,
		).toEqual([unread]);
	});

	it("reads a damaged stamp, or its entries that are no key, as none", () => {
		const one = [finding("o/a", [1])];
		expect(reportAtStart(one, "{torn", "2026-10-29").unseen).toHaveLength(1);
		expect(
			reportAtStart(one, stamp("2026-10-29", "x"), "2026-10-29").unseen,
		).toHaveLength(1);
		expect(
			reportAtStart(one, stamp("2026-10-29", [1]), "2026-10-29").signature,
		).toBe(stamp("2026-10-29", ["o/a#1"]));
	});
});
