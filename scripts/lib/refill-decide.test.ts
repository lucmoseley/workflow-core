/*
 * refill-decide.test.ts — away mode's decision core (#2007): every stop, the
 * seat failover, the founder's free slot, the launch filter and the merged
 * ranking, driven through `decideTick` from plain records, since the core is
 * pure. A break here launches the wrong ticket, or none, while he is away.
 */

import { describe, expect, it } from "vitest";

const { capSet } = require("./allowance.js");
const { ALREADY_RUNNING, FULL, decideTick } = require("./refill-decide.js");
const { capFitsOf, sizedSeats } = require("./refill-loop.js");
const { mergeFrontiers } = require("./frontier-order.js");

const NOW = Date.parse("2026-10-18T12:00:00Z");
const PRESENT_WINDOW_MS = 30 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const row = (
	root: string,
	number: number,
	takes = "implement",
	over: Record<string, unknown> = {},
) => ({
	root,
	number,
	urgent: false,
	goal: false,
	stallDays: 0,
	asksQuestions: false,
	reach: 0,
	collision: "comment-only",
	takes: [takes],
	labels: [`takes:${takes}`],
	...over,
});

const seat = (
	name: string,
	week: number | null,
	session: number | null,
	/* Over every case's free slots, so the cap binds only where a case sets
	 * it. */
	fits: number | null = 9,
) => ({
	seat: name,
	week,
	session,
	weekFull: week !== null && week >= FULL,
	sessionFull: session !== null && session >= FULL,
	sessionResets: null,
	fits,
});

const finished = (number: number, over: Record<string, unknown> = {}) => ({
	root: "wfc",
	issues: [number],
	launchedAt: NOW - 3 * HOUR,
	finishedAt: NOW - HOUR + number,
	acts: {},
	...over,
});

const tick = (over: Record<string, unknown> = {}) =>
	decideTick({
		now: NOW,
		startedAt: NOW - 4 * HOUR,
		stopRequested: false,
		frontier: [row("wfc", 1), row("wfc", 2), row("wfc", 3)],
		retroBundles: [],
		running: [],
		freeSlots: 2,
		lastPromptAt: null,
		seats: [seat("~/.claude3", 40, 20), seat("~/.claude2", 10, 10)],
		history: [],
		...over,
	});

const launched = (d: { launches?: { root: string; issues: number[] }[] }) =>
	(d.launches ?? []).map((l) => `${l.root}#${l.issues.join("+")}`);

describe("decideTick stops (#2007)", () => {
	it("stops on an explicit stop", () => {
		expect(tick({ stopRequested: true })).toMatchObject({ stop: "explicit" });
	});

	it("stops 24 hours after the last start, not before", () => {
		expect(tick({ startedAt: NOW - 24 * HOUR })).toMatchObject({
			stop: "expired",
		});
		expect(tick({ startedAt: NOW - 24 * HOUR + 1 })).not.toHaveProperty("stop");
	});

	it("stops after three finishes in a row with no progress", () => {
		const d = tick({ history: [finished(7), finished(8), finished(9)] });
		expect(d).toMatchObject({ stop: "no-progress" });
		expect(d.detail).toContain("wfc #9");
	});

	it.each(["commit", "close", "file", "round", "relabel"])(
		"counts a %s act as progress (#2312)",
		(kind) => {
			const d = tick({
				history: [
					finished(7),
					finished(8),
					finished(9, { acts: { [kind]: 1 } }),
				],
			});
			expect(d).not.toHaveProperty("stop");
		},
	);

	it("does not stop on three finishes whose only acts are blocks (#2464)", () => {
		const blocked = { acts: { block: 1 } };
		expect(
			tick({
				history: [
					finished(7, blocked),
					finished(8, blocked),
					finished(9, blocked),
				],
			}),
		).not.toHaveProperty("stop");
	});

	it("passes over an unread finish in the run, counting it neither way (#2312)", () => {
		const unread = { acts: "unread" };
		expect(
			tick({
				history: [finished(6), finished(7, unread), finished(8), finished(9)],
			}),
		).toMatchObject({ stop: "no-progress" });
		expect(
			tick({ history: [finished(7), finished(8, unread), finished(9)] }),
		).not.toHaveProperty("stop");
	});

	it("reads the run by finish order, so an older progress does not break it", () => {
		const d = tick({
			history: [
				finished(6, { acts: { close: 1 }, finishedAt: NOW - 2 * HOUR }),
				finished(7),
				finished(8),
				finished(9),
			],
		});
		expect(d).toMatchObject({ stop: "no-progress" });
	});

	it("ignores running sessions and launches from before the last start", () => {
		expect(
			tick({
				history: [
					finished(7),
					finished(8),
					finished(9, { finishedAt: null }),
					finished(10, { launchedAt: NOW - 5 * HOUR }),
				],
			}),
		).not.toHaveProperty("stop");
	});

	it("stops on allowance once every seat is weekly-full (#2606)", () => {
		expect(
			tick({
				seats: [
					seat("a", 100, 10),
					{ ...seat("b", null, null, null), weekFull: true },
				],
			}),
		).toMatchObject({
			stop: "allowance",
			detail: "every seat reads 100% of the week",
		});
	});

	it("waits through a 5-hour cap, naming the seat and its reset, and never stops (#2606)", () => {
		const d = tick({
			seats: [
				seat("a", 100, 10),
				{
					...seat("b", 50, 100, null),
					sessionResets: "2026-10-18T14:00:00Z",
				},
			],
		});
		expect(d).not.toHaveProperty("stop");
		expect(d).toMatchObject({
			launches: [],
			idle: "the 5-hour bar is full on b until its 5-hour reset 2026-10-18T14:00:00Z",
		});
	});

	it("names a 5-hour wait beside the seat with room that holds the tick", () => {
		const five = { ...seat("a", 40, 100, null), sessionResets: "3pm" };
		expect(tick({ seats: [five, seat("b", 98, 5, 0)] })).toMatchObject({
			idle: "the allowance cap fits no launch on b; the 5-hour bar is full on a until its 5-hour reset 3pm",
		});
		expect(tick({ seats: [five, seat("b", 98, 5, null)] })).toMatchObject({
			idle: "no seat with room has a sized allowance cap; the 5-hour bar is full on a until its 5-hour reset 3pm",
		});
	});

	it("names every seat waiting on its 5-hour bar, an unread reset as unread", () => {
		const d = tick({
			seats: [
				{ ...seat("a", 40, 100, null), sessionResets: "3pm" },
				seat("b", 50, 100),
			],
		});
		expect(d).toMatchObject({
			idle: "the 5-hour bar is full on a until its 5-hour reset 3pm, b until its 5-hour reset (unread)",
		});
	});

	it("waits without stopping when a seat with room has no fresh reading", () => {
		const d = tick({ seats: [seat("a", 100, 10), seat("b", null, 5)] });
		expect(d).not.toHaveProperty("stop");
		expect(d).toMatchObject({ launches: [], idle: expect.any(String) });
	});

	it("waits without stopping when a seat with room has no sized cap", () => {
		const d = tick({ seats: [seat("a", 100, 10), seat("b", 98, 5, null)] });
		expect(d).not.toHaveProperty("stop");
		expect(d).toMatchObject({
			launches: [],
			idle: "no seat with room has a sized allowance cap",
		});
	});
});

describe("decideTick seats", () => {
	it("launches on the first seat with both bars under 100%, in failover order", () => {
		const d = tick({
			seats: [seat("a", 100, 10), seat("b", 10, 100), seat("c", 99, 89)],
		});
		expect(d.launches.map((l: { seat: string }) => l.seat)).toEqual(["c", "c"]);
	});

	it("holds a seat at 98% of the week pickable, past the cap's threshold (#2278)", () => {
		const d = tick({ seats: [seat("a", 98, 10)] });
		expect(d).not.toHaveProperty("stop");
		expect(d.launches.map((l: { seat: string }) => l.seat)).toEqual(["a", "a"]);
	});

	it("falls through a seat the cap sized 0 to the next with room (#2432)", () => {
		const d = tick({ seats: [seat("a", 98, 10, 0), seat("b", 10, 10)] });
		expect(d.launches.map((l: { seat: string }) => l.seat)).toEqual(["b", "b"]);
	});

	it("launches no more than the cap would on the seat (#2278)", () => {
		const d = tick({ freeSlots: 3, seats: [seat("a", 98, 10, 1)] });
		expect(launched(d)).toEqual(["wfc#1"]);
	});
});

describe("decideTick on a seat whose cap fits only the floor's member (#2432)", () => {
	/* Seats at these week readings, sized through the real cap and the loop's
	 * reading of it; over 97% the running sessions are projected 3 points of
	 * the week, past 100%. */
	const sizedOn = (weeks: Record<string, number>) =>
		sizedSeats(
			Object.entries(weeks).map(([name, week]) => ({
				seat: name,
				week,
				session: 10,
			})),
			2,
			(name: string, members: number) =>
				capFitsOf(
					JSON.stringify({
						cap: capSet({
							readings: { session: 10, weekly_all: weeks[name] },
							thresholds: { session: 90, weekly_all: 97 },
							members,
							runningPoints: { session: 0, weekly_all: 3 },
							perSessionPoints: { session: 1.5, weekly_all: 0.1 },
						}),
					}),
				).fits,
		);

	it("launches on the next seat with room", () => {
		const d = tick({ seats: sizedOn({ s1: 98, s2: 10 }) });
		expect(d.launches.map((l: { seat: string }) => l.seat)).toEqual([
			"s2",
			"s2",
		]);
	});

	it("waits without stopping where every seat with room fits only the floor", () => {
		const d = tick({ seats: sizedOn({ s1: 98, s2: 98 }) });
		expect(d).not.toHaveProperty("stop");
		expect(d).toMatchObject({
			launches: [],
			idle: "the allowance cap fits no launch on s1, s2",
		});
	});
});

describe("decideTick free slot", () => {
	it("keeps one slot free while the founder is present", () => {
		const d = tick({ lastPromptAt: NOW - PRESENT_WINDOW_MS + 1 });
		expect(launched(d)).toEqual(["wfc#1"]);
	});

	it("releases it once the last prompt is 30 minutes old", () => {
		const d = tick({ lastPromptAt: NOW - PRESENT_WINDOW_MS });
		expect(launched(d)).toEqual(["wfc#1", "wfc#2"]);
	});

	it("launches nothing on the last free slot while present", () => {
		const d = tick({ freeSlots: 1, lastPromptAt: NOW });
		expect(d).toMatchObject({ launches: [], idle: expect.any(String) });
	});

	it("idles on the slot, not the seat, when none is free and every seat is unread (#2362)", () => {
		const unread = [seat("a", null, null, null), seat("b", null, null, null)];
		expect(tick({ freeSlots: 0, seats: unread })).toMatchObject({
			launches: [],
			idle: "no free slot",
		});
		expect(
			tick({ freeSlots: 1, lastPromptAt: NOW, seats: unread }),
		).toMatchObject({
			launches: [],
			idle: "one free slot is kept for the founder",
		});
	});

	it("names an unsized seat over an unread one behind it, which was never probed (#2362)", () => {
		const d = tick({
			seats: [seat("a", 40, 20, null), seat("b", null, null, null)],
		});
		expect(d).toMatchObject({
			launches: [],
			idle: "no seat with room has a sized allowance cap",
		});
	});

	it("idles on the cap where it fits no launch on any seat with room (#2362, #2432)", () => {
		const d = tick({
			seats: [seat("a", 98, 20, 0), seat("b", 100, 10), seat("c", 10, 10, 0)],
		});
		expect(d).not.toHaveProperty("stop");
		expect(d).toMatchObject({
			launches: [],
			idle: "the allowance cap fits no launch on a, c",
		});
	});

	it("idles on the unread seats where a slot is free (#2362)", () => {
		const d = tick({
			freeSlots: 2,
			seats: [seat("a", null, null, null), seat("b", null, null, null)],
		});
		expect(d).toMatchObject({
			launches: [],
			idle: "no seat has a fresh allowance reading",
		});
	});
});

describe("decideTick launch filter", () => {
	it("never launches human, children, waiting:external, parked, takes:wayfinder map or label-faulty rows", () => {
		const d = tick({
			freeSlots: 9,
			frontier: [
				row("wfc", 1, "human"),
				row("wfc", 2, "children"),
				row("wfc", 3, "implement", {
					labels: ["takes:implement", "waiting:external"],
				}),
				row("wfc", 4, "wayfinder", {
					labels: ["takes:wayfinder", "parked"],
				}),
				row("wfc", 5, "implement", { takes: ["implement", "triage"] }),
				row("wfc", 6, "implement", { takes: [] }),
				row("wfc", 7, "wayfinder", {
					labels: ["takes:wayfinder", "wayfinder:map"],
				}),
				row("wfc", 8, "triage"),
				row("wfc", 9, "wayfinder", {
					labels: ["takes:wayfinder", "wayfinder:grilling"],
				}),
			],
		});
		expect(launched(d)).toEqual(["wfc#8", "wfc#9"]);
		expect(d.skipped.map((s: { number: number }) => s.number)).toEqual([
			1, 2, 3, 4, 5, 6, 7,
		]);
	});

	it("launches a map at any kind but wayfinder (#2639)", () => {
		const d = tick({
			freeSlots: 9,
			frontier: ["to-spec", "to-tickets", "implement"].map((k, i) =>
				row("wfc", 1 + i, k, { labels: [`takes:${k}`, "wayfinder:map"] }),
			),
		});
		expect(d.launches.map((l: { prompt: string }) => l.prompt)).toEqual([
			"/to-spec 1",
			"/to-tickets 2",
			"/implement 3",
		]);
		expect(d.skipped).toEqual([]);
	});

	it("prompts each launchable kind with its own command, every one on Opus", () => {
		const kinds = ["implement", "wayfinder", "to-spec", "to-tickets", "triage"];
		const d = tick({
			freeSlots: 9,
			frontier: kinds.map((k, i) => row("wfc", 10 + i, k)),
		});
		expect(
			d.launches.map((l: { prompt: string; model: string }) => [
				l.prompt,
				l.model,
			]),
		).toEqual(kinds.map((k, i) => [`/${k} ${10 + i}`, "opus"]));
	});

	it("skips an issue already running in that repo, not its namesake elsewhere", () => {
		const d = tick({
			frontier: [row("wfc", 1), row("dv", 1), row("wfc", 2)],
			running: [{ root: "wfc", issues: [1] }],
		});
		expect(launched(d)).toEqual(["dv#1", "wfc#2"]);
		expect(d.skipped).toEqual([
			{ root: "wfc", number: 1, why: ALREADY_RUNNING },
		]);
	});

	it("skips a gate judgement whose issue is already running", () => {
		const d = tick({
			frontier: [],
			judgements: [{ root: "wfc", number: 3, prompt: "/triage 3" }],
			running: [{ root: "wfc", issues: [3] }],
		});
		expect(d.launches).toEqual([]);
		expect(d.skipped).toEqual([
			{ root: "wfc", number: 3, why: ALREADY_RUNNING },
		]);
	});

	it("launches a retro bundle once, with its printed prompt, on Opus", () => {
		const d = tick({
			frontier: [
				row("wfc", 4, "triage"),
				row("wfc", 5, "triage"),
				row("wfc", 6),
			],
			retroBundles: [
				{
					root: "wfc",
					issues: [4, 5],
					model: "sonnet",
					prompt: "/triage 4 5 …",
				},
			],
		});
		expect(d.launches).toEqual([
			expect.objectContaining({
				issues: [4, 5],
				prompt: "/triage 4 5 …",
				model: "opus",
			}),
			expect.objectContaining({ issues: [6], prompt: "/implement 6" }),
		]);
	});
});

describe("decideTick retro bundle with a running member", () => {
	it("skips the rest of the bundle, naming the running member", () => {
		const d = tick({
			frontier: [row("wfc", 5, "triage"), row("wfc", 6)],
			retroBundles: [
				{ root: "wfc", issues: [4, 5], model: "sonnet", prompt: "p" },
			],
			running: [{ root: "wfc", issues: [4] }],
		});
		expect(launched(d)).toEqual(["wfc#6"]);
		expect(d.skipped).toEqual([
			{ root: "wfc", number: 5, why: "its retro bundle's #4 is running" },
		]);
	});
});

describe("decideTick ranking", () => {
	it("follows the merged ranking: type level, then the repo launched least recently", () => {
		const { frontier, retroBundles } = mergeFrontiers([
			{
				root: "busy",
				lastLaunchAt: NOW - HOUR,
				retroBundles: [],
				rows: [
					row("busy", 1),
					row("busy", 2, "wayfinder", { asksQuestions: true }),
				],
			},
			{
				root: "quiet",
				lastLaunchAt: NOW - 9 * HOUR,
				retroBundles: [],
				rows: [row("quiet", 3)],
			},
		]);
		const d = tick({ frontier, retroBundles, freeSlots: 3 });
		expect(launched(d)).toEqual(["busy#2", "quiet#3", "busy#1"]);
	});
});
