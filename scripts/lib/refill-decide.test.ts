/*
 * refill-decide.test.ts — away mode's decision core (#2007): every stop, the
 * seat failover, the free slots, the launch filter and the merged
 * ranking, driven through `decideTick` from plain records, since the core is
 * pure. A break here launches the wrong ticket, or none, while he is away.
 *
 * The progress table lists act kinds by hand, so the progress test covers each
 * kind a writer emits; a kind added to act-line.js gets no case. Deleting one
 * there leaves this table green, since progress counts any key: act-line.test.ts
 * is the table that goes red (#3312).
 */

import { describe, expect, it } from "vitest";
import { row } from "./refill-loop-fixture";

const {
	FULL,
	awayChangeOf,
	buildLimitCapText,
	buildLoopWait,
	buildIdleText,
	decideTick,
	pickMoveSeat,
	readParkers,
} = require("./refill-decide.js");

const buildIdle = (reason: string, detail = "") => ({ reason, detail });
const { mergeFrontiers } = require("./frontier-order.js");
const { buildVerifyPrompt } = require("./unclosed-launch.js");

const NOW = Date.parse("2026-10-18T12:00:00Z");
const PRESENT_WINDOW_MS = 30 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
/** The cap refill-decide.js keeps to itself, pinned here. */
const LIMIT_PARK_CAP = 2;

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
	weekResets: null,
	readAt: NOW,
	weekRead: { percent: null, atMs: null },
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
		mode: "away",
		noProgressFrom: NOW - 4 * HOUR,
		stopRequested: false,
		frontier: [row("wfc", 1), row("wfc", 2), row("wfc", 3)],
		retroBundles: [],
		running: [],
		freeSlots: 2,
		seats: [seat("~/.claude3", 40, 20), seat("~/.claude2", 10, 10)],
		history: [],
		lastActAt: null,
		...over,
	});

const launched = (d: { launches?: { root: string; issues: number[] }[] }) =>
	(d.launches ?? []).map((l) => `${l.root}#${l.issues.join("+")}`);

describe("away mode's return (#3870)", () => {
	const Switched = NOW - 8 * HOUR;
	const PromptBeforeSwitch = Switched - 5 * 60 * 1000;
	/** Each tick's change, a mode and absent read carried over as the tick writes them; the switch at `since`, Switched where omitted. */
	const changesOver = (
		ticks: { now: number; lastPromptAt: number | null }[],
		since = Switched,
	) => {
		let control = {
			mode: "away",
			away: { since, absentSeen: false },
		};
		return ticks.map(({ now, lastPromptAt }) => {
			const change = awayChangeOf(control, lastPromptAt, now);
			if (change === "absent")
				control = { ...control, away: { ...control.away, absentSeen: true } };
			if (change === "return") control = { ...control, mode: "normal" };
			return change;
		});
	};

	it("returns on the first present read after an absent one", () => {
		expect(
			changesOver([
				{ now: Switched + HOUR, lastPromptAt: PromptBeforeSwitch },
				{ now: Switched + 2 * HOUR, lastPromptAt: PromptBeforeSwitch },
				{ now: NOW, lastPromptAt: NOW - 1000 },
				{ now: NOW + 1000, lastPromptAt: NOW - 1000 },
			]),
		).toEqual(["absent", null, "return", null]);
	});

	it("stays away while every read since the switch is present", () => {
		const typing = [1, 10, 20, 29].map((minutes) => {
			const now = Switched + minutes * 60 * 1000;
			return { now, lastPromptAt: now - 1000 };
		});
		expect(changesOver(typing)).toEqual([null, null, null, null]);
	});

	it("returns from a switch made while present, once an absent read follows", () => {
		const typedAfterSwitch = Switched + 60 * 1000;
		expect(
			changesOver([
				{ now: Switched + 2 * 60 * 1000, lastPromptAt: typedAfterSwitch },
				{
					now: typedAfterSwitch + PRESENT_WINDOW_MS,
					lastPromptAt: typedAfterSwitch,
				},
				{ now: NOW, lastPromptAt: NOW - 1000 },
			]),
		).toEqual([null, "absent", "return"]);
	});

	it("stays away through a prompt soon after a switch made long after the last one (#4184)", () => {
		const oneMinuteOn = NOW + 60 * 1000;
		expect(
			changesOver(
				[
					{ now: NOW, lastPromptAt: NOW - PRESENT_WINDOW_MS - 10 * 60 * 1000 },
					{ now: oneMinuteOn, lastPromptAt: oneMinuteOn },
				],
				NOW,
			),
		).toEqual([null, null]);
	});

	it("reads no record of a prompt as present for one window after the switch (#4184)", () => {
		expect(
			changesOver(
				[
					{ now: NOW, lastPromptAt: null },
					{ now: NOW + PRESENT_WINDOW_MS, lastPromptAt: null },
				],
				NOW,
			),
		).toEqual([null, "absent"]);
	});

	it("reads no record of a prompt as absent, and changes nothing in normal mode", () => {
		expect(changesOver([{ now: NOW, lastPromptAt: null }])).toEqual(["absent"]);
		expect(awayChangeOf({ mode: "normal" }, NOW - 1000, NOW)).toBeNull();
	});
});

describe("a repo hold (#3860)", () => {
	const frontier = [row("wfc", 1), row("other", 2)];
	const withheld = {
		root: "wfc",
		number: 1,
		why: "a probe hold stops launches into its checkout",
	};

	it("withholds a probe-held checkout's launches and no other's", () => {
		const d = tick({ frontier, holds: [{ root: "wfc", kind: "probe" }] });

		expect(launched(d)).toEqual(["other#2"]);
		expect(d).toMatchObject({ skipped: [withheld] });
	});

	it("withholds a probe-held checkout's gate judgements too", () => {
		const d = tick({
			frontier: [],
			judgements: [{ root: "wfc", number: 1, prompt: "/judge 1" }],
			holds: [{ root: "wfc", kind: "probe" }],
		});

		expect(launched(d)).toEqual([]);
		expect(d).toMatchObject({ skipped: [withheld] });
	});

	it("keeps a probe-held checkout's held session back, its slot free for the other", () => {
		const d = tick({
			frontier,
			freeSlots: 1,
			resumable: [{ jobId: "j", root: "wfc", at: NOW - HOUR, line: "j" }],
			holds: [{ root: "wfc", kind: "probe" }],
		});

		expect(d).toMatchObject({ resumes: [] });
		expect(launched(d)).toEqual(["other#2"]);
	});

	it("withholds nothing for a park hold", () => {
		const d = tick({ frontier, holds: [{ root: "wfc", kind: "park" }] });

		expect(launched(d)).toEqual(["wfc#1", "other#2"]);
	});
});

describe("decideTick's stops and pauses (#2007, #3859)", () => {
	it("stops on an explicit stop", () => {
		expect(tick({ stopRequested: true })).toMatchObject({ stop: "explicit" });
	});

	it("stops on a damaged control ahead of the explicit stop it reads as (#3389)", () => {
		expect(
			tick({ stopRequested: true, controlDamaged: "/c is damaged (bad)" }),
		).toEqual({ stop: "control-damaged", detail: "/c is damaged (bad)" });
	});

	describe("a paused loop (#3856)", () => {
		const paused = { by: "founder", at: NOW - HOUR };
		const idle = {
			launches: [],
			skipped: [],
			idle: buildIdle(
				"paused by",
				` founder at ${new Date(NOW - HOUR).toISOString()}`,
			),
			held: [],
			resumes: [],
		};

		it("idles, launching nothing, ranked tickets and gate judgements alike", () => {
			expect(
				tick({
					paused,
					judgements: [{ root: "wfc", number: 4, prompt: "/judge 4" }],
					resumable: [{ jobId: "j", at: NOW - HOUR, line: "j" }],
				}),
			).toEqual(idle);
		});

		it("yields to an explicit stop and to a damaged control", () => {
			expect(tick({ paused, stopRequested: true })).toMatchObject({
				stop: "explicit",
			});
			expect(tick({ paused, controlDamaged: "/c is damaged" })).toMatchObject({
				stop: "control-damaged",
			});
		});

		it("comes ahead of the no-progress pause and the allowance wait", () => {
			expect(
				tick({ paused, history: [finished(7), finished(8), finished(9)] }),
			).toEqual(idle);
			expect(tick({ paused, seats: [seat("~/.claude3", FULL, 20)] })).toEqual(
				idle,
			);
		});

		it("counts no finish before a resume's new count point", () => {
			const history = [finished(7), finished(8), finished(9)];
			expect(tick({ history, noProgressFrom: NOW })).not.toHaveProperty(
				"pause",
			);
		});
	});

	it("gives a loop started any length of time ago no stop for its age", () => {
		expect(tick({ noProgressFrom: 0 })).not.toHaveProperty("stop");
	});

	it("pauses after three finishes in a row with no progress, naming their issues once (#3859)", () => {
		const d = tick({
			history: [
				finished(7),
				finished(9, { root: "/h/mh" }),
				finished(7, { finishedAt: NOW - 1 }),
			],
		});
		expect(d).not.toHaveProperty("stop");
		expect(d).toMatchObject({
			launches: [],
			pause: {
				by: "no-progress",
				at: NOW,
				issues: expect.arrayContaining([
					{ root: "/h/mh", number: 9 },
					{ root: expect.any(String), number: 7 },
				]),
			},
		});
		expect(d.idle?.reason).toBe("paused by");
		expect(d.idle?.detail).toContain(": no act from ");
		expect(d.idle?.detail).toContain("mh#9");
	});

	it.each(["block", "close", "commit", "file", "gate", "relabel", "round"])(
		"counts a %s act as progress (#2312, #3301)",
		(kind) => {
			const d = tick({
				history: [
					finished(7),
					finished(8),
					finished(9, { acts: { [kind]: 1 } }),
				],
			});
			expect(d).not.toHaveProperty("pause");
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
		).not.toHaveProperty("pause");
	});

	it("passes over an unread finish in the run, counting it neither way (#2312)", () => {
		const unread = { acts: "unread" };
		expect(
			tick({
				history: [finished(6), finished(7, unread), finished(8), finished(9)],
			}),
		).toHaveProperty("pause.by", "no-progress");
		expect(
			tick({ history: [finished(7), finished(8, unread), finished(9)] }),
		).not.toHaveProperty("pause");
	});

	it("passes over a resume with nothing to repeat that made no act, but counts other resumes and one the loop parked again (#3949, #3942)", () => {
		const woken = { nothingToRepeat: true };
		expect(
			tick({
				history: [finished(7, woken), finished(8, woken), finished(9, woken)],
			}),
		).not.toHaveProperty("pause");
		expect(
			tick({
				history: [finished(6), finished(7, woken), finished(8), finished(9)],
			}),
		).toHaveProperty("pause.by", "no-progress");
		const parkedAgain = { ...woken, parkStopped: NOW - HOUR };
		expect(
			tick({
				history: [
					finished(7, parkedAgain),
					finished(8, parkedAgain),
					finished(9, parkedAgain),
				],
			}),
		).toHaveProperty("pause.by", "no-progress");
	});

	it("passes over gate judgements that end unmet, with no act, but counts one that acted (#3092)", () => {
		const gate = { gate: true };
		expect(
			tick({
				history: [
					finished(2906, gate),
					finished(2917, gate),
					finished(3073, gate),
				],
			}),
		).not.toHaveProperty("pause");
		expect(
			tick({
				history: [finished(7), finished(2906, gate), finished(8), finished(9)],
			}),
		).toHaveProperty("pause.by", "no-progress");
		expect(
			tick({
				history: [
					finished(7),
					finished(8),
					finished(2906, { ...gate, acts: { relabel: 1 } }),
				],
			}),
		).not.toHaveProperty("pause");
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
		expect(d).toHaveProperty("pause.by", "no-progress");
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
		).not.toHaveProperty("pause");
	});

	it("waits on the earliest weekly reset once every seat is weekly-full (#3859)", () => {
		const earliest = NOW + 1000;
		const d = tick({
			seats: [
				{ ...seat("a", 100, 10), weekResets: NOW + 5000 },
				{
					...seat("b", null, null, null),
					weekFull: true,
					weekResets: earliest,
				},
				{ ...seat("c", 100, 10), weekResets: null },
			],
		});
		expect(d).not.toHaveProperty("stop");
		expect(d).toMatchObject({
			launches: [],
			planWait: { resets: earliest },
			idle: buildIdle(
				"a plan resets",
				` at ${new Date(earliest).toISOString()}`,
			),
		});
		expect(buildLoopWait(d.idle)).toBe(
			`a plan resets at ${new Date(earliest).toISOString()}`,
		);
	});

	it("waits on the allowance with the reset unread where no seat's will parse", () => {
		expect(tick({ seats: [seat("a", 100, 10)] })).toMatchObject({
			planWait: { resets: null },
			idle: buildIdle("a plan resets", ", its time unread"),
		});
	});

	it("waits on the allowance ahead of a full house of slots, launching nothing", () => {
		expect(tick({ seats: [seat("a", 100, 10)], freeSlots: 0 })).toHaveProperty(
			"planWait.resets",
			null,
		);
	});

	it("launches on the first tick a bar has reset", () => {
		expect(
			tick({ seats: [seat("a", 10, 10)], frontier: [row("/r", 1)] }).launches,
		).toHaveLength(1);
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
			idle: buildIdle(
				"the 5-hour bar is full on",
				" b until its 5-hour reset 2026-10-18T14:00:00Z",
			),
		});
	});

	it("names a 5-hour wait beside the seat with room that holds the tick", () => {
		const five = { ...seat("a", 40, 100, null), sessionResets: "3pm" };
		expect(tick({ seats: [five, seat("b", 98, 5, 0)] })).toMatchObject({
			idle: buildIdle(
				"no plan has room right now",
				"; the 5-hour bar is full on a until its 5-hour reset 3pm",
			),
		});
		expect(tick({ seats: [five, seat("b", 98, 5, null)] })).toMatchObject({
			idle: buildIdle(
				"no plan has room right now",
				"; the 5-hour bar is full on a until its 5-hour reset 3pm",
			),
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
			idle: buildIdle(
				"the 5-hour bar is full on",
				" a until its 5-hour reset 3pm, b until its 5-hour reset (unread)",
			),
		});
	});

	it("waits without stopping when a seat with room has no fresh reading", () => {
		const d = tick({ seats: [seat("a", 100, 10), seat("b", null, 5)] });
		expect(d).not.toHaveProperty("stop");
		expect(d).toMatchObject({
			launches: [],
			idle: buildIdle("no plan has room right now"),
		});
	});

	it("waits without stopping when a seat with room has no sized cap", () => {
		const d = tick({ seats: [seat("a", 100, 10), seat("b", 98, 5, null)] });
		expect(d).not.toHaveProperty("stop");
		expect(d).toMatchObject({
			launches: [],
			idle: buildIdle("no plan has room right now"),
		});
	});
});

describe("decideTick on overflow seats (#2611)", () => {
	const full = (name: string) => seat(name, 100, 10, null);
	const overflow = (
		name: string,
		fits: number | null,
		spentUntil: string | null = null,
	) => ({
		seat: name,
		fits,
		spentUntil,
		why: fits === null ? "the session cost table is unreadable" : null,
	});
	const seats = (d: { launches?: { seat: string }[] }) =>
		(d.launches ?? []).map((l) => l.seat);

	it("launches on an overflow seat only once every plan seat is weekly-full, on Opus", () => {
		const d = tick({
			seats: [full("a"), full("b")],
			overflow: [overflow("x", 5)],
		});
		expect(seats(d)).toEqual(["x", "x"]);
		expect(d.launches.map((l: { model: string }) => l.model)).toEqual([
			"opus",
			"opus",
		]);
		expect(launched(d)).toEqual(["wfc#1", "wfc#2"]);
	});

	it("never overflows while a plan seat is not weekly-full, naming it", () => {
		const five = { ...seat("b", 50, 100, null), sessionResets: "3pm" };
		const d = tick({ seats: [full("a"), five], overflow: [overflow("x", 5)] });
		expect(d).not.toHaveProperty("stop");
		expect(d).toMatchObject({
			launches: [],
			idle: buildIdle(
				"the 5-hour bar is full on",
				" b until its 5-hour reset 3pm; no overflow launch: b not weekly-full",
			),
		});
		expect(
			seats(
				tick({
					seats: [full("a"), seat("b", 10, 10)],
					overflow: [overflow("x", 5)],
				}),
			),
		).toEqual(["b", "b"]);
	});

	it("takes the first overflow seat in failover order whose budget fits a launch", () => {
		const d = tick({
			seats: [full("a")],
			overflow: [
				overflow("x", 0, "2026-11-20"),
				overflow("y", 3),
				overflow("z", 9),
			],
		});
		expect(seats(d)).toEqual(["y", "y"]);
	});

	it("launches no more than the budget fits", () => {
		const d = tick({
			freeSlots: 3,
			seats: [full("a")],
			overflow: [overflow("x", 1)],
		});
		expect(launched(d)).toEqual(["wfc#1"]);
	});

	it("waits, never stopping, on a budget held by running sessions or unread", () => {
		const d = tick({
			seats: [full("a")],
			overflow: [
				overflow("x", 0),
				overflow("y", null),
				overflow("z", 0, "2026-10-28"),
			],
		});
		expect(d).not.toHaveProperty("stop");
		expect(d).toMatchObject({
			launches: [],
			idle: buildIdle(
				"a plan resets",
				", its time unread; every plan seat is weekly-full; overflow x budget held by running sessions, y budget unread (the session cost table is unreadable), z exhausted until 2026-10-28",
			),
		});
	});

	it("waits on the allowance once every plan seat is weekly-full and every key is spent", () => {
		expect(
			tick({
				seats: [full("a"), full("b")],
				overflow: [
					overflow("x", 0, "2026-11-20"),
					overflow("y", 0, "2026-10-28"),
				],
			}),
		).toMatchObject({
			launches: [],
			planWait: { resets: null },
			idle: { reason: "a plan resets", detail: expect.any(String) },
		});
	});

	it("decides as before with no overflow seat declared", () => {
		for (const plan of [[full("a")], [full("a"), seat("b", 10, 10)]])
			expect(tick({ seats: plan, overflow: [] })).toEqual(
				tick({ seats: plan }),
			);
	});
});

describe("pickMoveSeat (#3735)", () => {
	const Blocked = NOW - 10 * 60 * 1000;
	const own = (week: number | null, session: number | null, over = {}) => ({
		...seat("own", week, session),
		readAt: NOW,
		...over,
	});
	const pick = (
		seats: object[],
		typedSeat: string | null = null,
		overflow = {},
	) =>
		pickMoveSeat({
			seats,
			typedSeat,
			ownSeat: "own",
			since: Blocked,
			...overflow,
		});
	const api = { seat: "api", fits: 2, spentUntil: null, why: null };

	it("never returns the blocked seat while its limit holds", () => {
		expect(pick([own(50, FULL, { fits: null })]).seat).toBeNull();
		expect(pick([own(FULL, 10, { fits: null })]).seat).toBeNull();
		expect(pick([own(95, 95, { fits: 0 })]).seat).toBeNull();
		expect(pick([own(null, null, { fits: null })]).seat).toBeNull();
	});

	it("follows the launch order: last typed, then soonest weekly reset (#3734)", () => {
		const blocked = own(FULL, 10, { fits: null });
		const later = {
			...seat("later", 10, 10),
			weekResets: NOW + 2 * HOUR,
			fits: 1,
		};
		const sooner = {
			...seat("sooner", 10, 10),
			weekResets: NOW + HOUR,
			fits: 1,
		};
		const seats = [blocked, later, sooner];
		expect(pick(seats)).toMatchObject({
			seat: "sooner",
			reason: "soonest reset",
		});
		expect(pick(seats, "later")).toMatchObject({
			seat: "later",
			reason: "last typed on",
		});
	});

	it("passes over a seat a limit moved it off until a reading since that block (#3734)", () => {
		const left = [{ seat: "gone", since: Blocked }];
		const blocked = own(FULL, 10, { fits: null });
		const gone = (readAt: number) => ({
			...seat("gone", 10, 10),
			readAt,
			fits: 1,
		});
		expect(pick([blocked, gone(Blocked - 1)], null, { left }).seat).toBeNull();
		expect(pick([blocked, gone(NOW)], null, { left }).seat).toBe("gone");
	});

	it("passes over a reading older than the block, however low it reads", () => {
		expect(pick([own(50, 50, { readAt: Blocked })]).seat).toBeNull();
		expect(pick([own(50, 50, { readAt: Blocked - 1 })]).seat).toBeNull();
	});

	it("returns it once a reading since the block shows it under the cut", () => {
		expect(pick([own(50, 50)]).seat).toBe("own");
	});

	it("walks a launch's order: the typed seat, then the soonest reset", () => {
		const other = seat("other", 10, 10);
		expect(pick([own(50, 50), other], "other").seat).toBe("other");
		expect(pick([own(50, 50), other], "own").seat).toBe("own");
		expect(
			pick([
				{ ...own(50, 50), weekResets: NOW + 2 * HOUR },
				{ ...other, weekResets: NOW + HOUR },
			]).seat,
		).toBe("other");
	});

	it("takes overflow only once every plan seat is weekly-full", () => {
		const overflow = { overflow: [api] };
		const fiveHourOwn = own(50, FULL, { fits: null });
		const weeklyOther = seat("other", FULL, 10, null);
		expect(pick([fiveHourOwn, weeklyOther], null, overflow).seat).toBeNull();
		const weeklyOwn = own(FULL, 10, { fits: null });
		expect(pick([weeklyOwn, weeklyOther], null, overflow).seat).toBe("api");
	});

	it("holds a weekly block while another plan seat is full on its 5-hour bar alone, or the key fits none (#3736)", () => {
		const weeklyOwn = own(FULL, 10, { fits: null });
		const fiveHourOther = seat("other", 50, FULL, null);
		expect(
			pick([weeklyOwn, fiveHourOther], null, { overflow: [api] }).seat,
		).toBeNull();
		const weeklyOther = seat("other", FULL, 10, null);
		expect(
			pick([weeklyOwn, weeklyOther], null, {
				overflow: [{ ...api, fits: 0 }],
			}).seat,
		).toBeNull();
	});

	it("returns the key of the overflow seat it picks, on a dir a plan seat shares (#3736)", () => {
		const weeklyOwn = own(FULL, 10, { fits: null });
		const onOwnDir = { ...api, seat: "own", keyVar: "K" };
		expect(pick([weeklyOwn], null, { overflow: [onOwnDir] })).toMatchObject({
			seat: "own",
			keyVar: "K",
			reason: "overflow",
		});
	});
});

describe("decideTick with a limit-held launch (#3735)", () => {
	const spent = {
		seats: [seat("a", FULL, 10, null)],
		frontier: [row("/r", 1)],
	};

	it("keeps a run on spent seats alive, so the loop can resume it", () => {
		expect(tick(spent)).toHaveProperty("planWait.resets", null);
		expect(tick({ ...spent, limitHeldLines: [] })).toHaveProperty(
			"planWait.resets",
			null,
		);
		const held = tick({ ...spent, limitHeldLines: ["job42 on ~/.claude2"] });
		expect(held).not.toHaveProperty("stop");
		expect(held).toMatchObject({
			launches: [],
			planWait: { resets: null },
			idle: buildIdle(
				"a plan resets",
				", its time unread; every seat is spent; a limit-held session waits on one",
			),
		});
	});

	it("leaves every other stop standing", () => {
		expect(
			tick({ ...spent, limitHeldLines: ["job42"], stopRequested: true }),
		).toHaveProperty("stop", "explicit");
	});

	it("names each session a stop leaves held (#3785)", () => {
		expect(
			tick({
				...spent,
				limitHeldLines: ["job42 on ~/.claude2", "job43 on ~/.claude3"],
				stopRequested: true,
			}),
		).toMatchObject({
			stop: "explicit",
			detail: expect.stringMatching(
				/stop was requested; .*next start: job42 on ~\/\.claude2; job43 on ~\/\.claude3$/,
			),
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

describe("decideTick's seat order and reason (#3732)", () => {
	const Day = 24 * HOUR;
	/* A plan seat with room whose week resets `days` from now, null unread. */
	const on = (
		name: string,
		days: number | null,
		over: Record<string, unknown> = {},
	) => ({
		...seat(name, 40, 20),
		weekResets: days === null ? null : NOW + days * Day,
		...over,
	});
	const picked = (d: { launches?: { seat: string; reason: string }[] }) => [
		...new Set((d.launches ?? []).map((l) => `${l.seat} ${l.reason}`)),
	];

	it("launches on the seat the founder last typed on first", () => {
		const d = tick({ seats: [on("a", 3), on("b", 1)], typedSeat: "a" });
		expect(picked(d)).toEqual(["a last typed on"]);
	});

	it("takes the soonest weekly reset next, once the typed seat is past the cut", () => {
		const d = tick({
			seats: [on("a", 1, { fits: 0 }), on("b", 3), on("c", 2)],
			typedSeat: "a",
		});
		expect(picked(d)).toEqual(["c soonest reset"]);
	});

	it("falls back to the soonest reset with no typed seat recorded, or one not listed", () => {
		const seats = [on("a", 3), on("b", 2), on("c", 5)];
		expect(picked(tick({ seats }))).toEqual(["b soonest reset"]);
		expect(picked(tick({ seats, typedSeat: null }))).toEqual([
			"b soonest reset",
		]);
		expect(picked(tick({ seats, typedSeat: "z" }))).toEqual([
			"b soonest reset",
		]);
	});

	it("sorts an unread reset after every read one, ties in seat-file order", () => {
		expect(
			picked(tick({ seats: [on("a", null), on("b", 4), on("c", 4)] })),
		).toEqual(["b soonest reset"]);
		expect(picked(tick({ seats: [on("a", null), on("b", null)] }))).toEqual([
			"a soonest reset",
		]);
	});

	it("waits through a 5-hour-full typed seat only where no other seat has room", () => {
		const five = on("a", 1, {
			session: FULL,
			sessionFull: true,
			sessionResets: "3pm",
		});
		expect(picked(tick({ seats: [five, on("b", 3)], typedSeat: "a" }))).toEqual(
			["b soonest reset"],
		);
		const d = tick({ seats: [five, on("b", 3, { fits: 0 })], typedSeat: "a" });
		expect(d).toMatchObject({ launches: [] });
		expect(d.idle && buildIdleText(d.idle)).toContain(
			"the 5-hour bar is full on a",
		);
	});

	it("overflows only once every plan seat is weekly-full, with its reason", () => {
		const overflow = [{ seat: "x", fits: 5, spentUntil: null, why: null }];
		const weekFull = (name: string) =>
			on(name, 1, { week: FULL, weekFull: true, fits: null });
		expect(
			picked(
				tick({
					seats: [weekFull("a"), weekFull("b")],
					typedSeat: "a",
					overflow,
				}),
			),
		).toEqual(["x overflow"]);
		const five = on("a", 1, { session: FULL, sessionFull: true, fits: null });
		expect(
			picked(tick({ seats: [five, weekFull("b")], typedSeat: "a", overflow })),
		).toEqual([]);
	});
});

describe("buildLoopWait, the idle alarm's reason no rank launches (#3920)", () => {
	const spent = { seats: [seat("a", FULL, 10, null)], frontier: [] };
	const paused = { by: "founder", at: NOW };
	const due = { jobId: "j", seat: "a", at: NOW, line: "j held" };

	it.each([
		["a pause", { paused }, true],
		[
			"spent seats on a limit-held session",
			{ ...spent, limitHeldLines: ["j"] },
			true,
		],
		["spent seats with a resume due", { ...spent, resumable: [due] }, true],
		["no free slot", { freeSlots: 0 }, false],
		["resumes taking every slot", { freeSlots: 1, resumable: [due] }, false],
		["nothing launchable", { frontier: [] }, false],
		[
			"a failed shortlist",
			{ frontier: [], failedShortlists: [{ root: "/r", error: "boom" }] },
			false,
		],
	])(
		"reads %s, each tick launching nothing giving its reason",
		(_case, over, named) => {
			const d = tick(over);
			expect(d.launches).toEqual([]);
			expect(d.idle).not.toBeNull();
			expect(buildLoopWait(d.idle)).toBe(
				named && d.idle ? buildIdleText(d.idle) : null,
			);
		},
	);

	it("names a reason it does not know, and none for a tick that launched", () => {
		expect(buildLoopWait(buildIdle("a stop added later"))).toBe(
			"a stop added later",
		);
		expect(buildLoopWait(null)).toBeNull();
	});
});

describe("decideTick's resumes of held sessions (#3855)", () => {
	const held = (jobId: string, at: number, onSeat = "a") => ({
		jobId,
		seat: onSeat,
		at,
		line: `${jobId} held`,
	});
	const jobs = (d: { resumes: { jobId: string }[] }) =>
		d.resumes.map((r) => r.jobId);
	const newest = held("new", NOW - HOUR);
	const middle = held("mid", NOW - 2 * HOUR);
	const oldest = held("old", NOW - 3 * HOUR);

	it("orders resumes oldest first, whatever order they were read in", () => {
		const d = tick({ freeSlots: 3, resumable: [newest, oldest, middle] });
		expect(jobs(d)).toEqual(["old", "mid", "new"]);
	});

	it("shares the free slots with launches, resumes taken first", () => {
		const d = tick({ freeSlots: 3, resumable: [newest, oldest] });
		expect(jobs(d)).toEqual(["old", "new"]);
		expect(launched(d)).toEqual(["wfc#1"]);
	});

	it("leaves overflow resumes for a later tick and launches nothing", () => {
		const d = tick({ freeSlots: 2, resumable: [newest, middle, oldest] });
		expect(jobs(d)).toEqual(["old", "mid"]);
		expect(d).toMatchObject({
			launches: [],
			idle: buildIdle("resumes take every free slot"),
		});
		expect(jobs(tick({ freeSlots: 1, resumable: [newest] }))).toEqual(["new"]);
	});

	it("resumes nothing with no slot free", () => {
		expect(tick({ freeSlots: 0, resumable: [oldest] })).toMatchObject({
			resumes: [],
			idle: buildIdle("no free slot"),
		});
	});

	it("resumes though no seat fits a launch: a resume goes back to its own seat", () => {
		const d = tick({
			freeSlots: 2,
			seats: [seat("a", 10, FULL, null)],
			resumable: [oldest],
		});
		expect(jobs(d)).toEqual(["old"]);
		expect(d).toMatchObject({ launches: [] });
	});

	describe("charged to its own seat's cap (#3895)", () => {
		it("charges an overflow seat's resume none of the plan seat's cap on its dir, and is held by none (#4147)", () => {
			const onKey = { ...oldest, keyVar: "K2" };
			const spare = tick({
				freeSlots: 4,
				seats: [seat("a", 10, 10, 1)],
				resumable: [onKey],
			});
			expect(jobs(spare)).toEqual(["old"]);
			expect(launched(spare)).toEqual(["wfc#1"]);
			const spent = tick({
				freeSlots: 4,
				seats: [seat("a", 10, 10, 0)],
				resumable: [onKey],
			});
			expect(jobs(spent)).toEqual(["old"]);
			expect(spent).toMatchObject({ capHeld: [] });
		});

		it("charges a resume to its seat's cap, leaving launches what remains", () => {
			const d = tick({
				freeSlots: 4,
				seats: [seat("a", 10, 10, 2)],
				resumable: [oldest],
			});
			expect(jobs(d)).toEqual(["old"]);
			expect(launched(d)).toEqual(["wfc#1"]);
		});

		it("launches on the next seat where a resume took the first seat's last fit", () => {
			const d = tick({
				freeSlots: 3,
				seats: [seat("a", 10, 10, 1), seat("b", 10, 10, 1)],
				resumable: [oldest],
			}) as { launches: { seat: string }[]; resumes: { jobId: string }[] };
			expect(jobs(d)).toEqual(["old"]);
			expect(d.launches.map((l) => l.seat)).toEqual(["b"]);
		});

		it("starts a resume only while its seat's cap has a fit, oldest first", () => {
			const d = tick({
				freeSlots: 3,
				seats: [seat("a", 10, 10, 1), seat("b", 10, 10, 1)],
				resumable: [newest, oldest, held("other", NOW - HOUR, "b")],
			});
			expect(jobs(d)).toEqual(["old", "other"]);
			expect(d).toMatchObject({ launches: [] });
		});

		it("names the resume its seat's cap holds, beside one another seat starts (#3911)", () => {
			const onB = held("other", NOW - HOUR, "b");
			const d = tick({
				freeSlots: 3,
				seats: [seat("a", 10, 10, 0), seat("b", 10, 10, 3)],
				resumable: [oldest, onB],
			});
			expect(jobs(d)).toEqual(["other"]);
			expect(d).toMatchObject({ capHeld: [oldest] });
		});

		it("names the resume whose seat an older resume took the last fit of (#3911)", () => {
			const d = tick({
				freeSlots: 3,
				seats: [seat("a", 10, 10, 1)],
				resumable: [newest, oldest],
			});
			expect(jobs(d)).toEqual(["old"]);
			expect(d).toMatchObject({ capHeld: [newest] });
		});

		it("names no resume behind the last slot, its seat sized for the slots alone (#3911)", () => {
			const d = tick({
				freeSlots: 2,
				seats: [seat("a", 10, 10, 2)],
				resumable: [newest, middle, oldest],
			});
			expect(jobs(d)).toEqual(["old", "mid"]);
			expect(d).toMatchObject({ capHeld: [] });
		});

		it("names no resume on a tick with no slot free (#3911)", () => {
			const d = tick({
				freeSlots: 0,
				seats: [seat("a", 10, 10, 0)],
				resumable: [oldest],
			});
			expect(jobs(d)).toEqual([]);
			expect(d).not.toHaveProperty("capHeld");
		});

		it("charges nothing for a resume on a seat the tick does not read", () => {
			const d = tick({
				freeSlots: 3,
				seats: [seat("a", 10, 10, 1)],
				resumable: [held("gone", NOW - HOUR, "elsewhere")],
			});
			expect(jobs(d)).toEqual(["gone"]);
			expect(launched(d)).toEqual(["wfc#1"]);
		});

		describe("beside a parked row whose session is on the same seat", () => {
			const parkedRow = row("wfc", 7, "implement", {
				labels: ["takes:implement", "parked"],
				parkedAt: "2026-10-18T09:00:00Z",
			});
			const parkers = [
				{
					root: "wfc",
					number: 7,
					sessionId: "s7",
					job: { seat: "a", jobId: "j7" },
					resumeCwd: "/c",
				},
			];
			const beside = (seats: ReturnType<typeof seat>[]) =>
				tick({
					mode: "normal",
					freeSlots: 3,
					frontier: [parkedRow],
					parkers,
					seats,
					resumable: [oldest],
				});

			it("starts the swap resume and leaves the parked row waiting, on one fit", () => {
				const d = beside([seat("a", 10, 10, 1)]);
				expect(jobs(d)).toEqual(["old"]);
				expect(launched(d)).toEqual([]);
			});

			it("holds the parked row where a launch goes to another seat", () => {
				const d = beside([seat("a", 10, 10, 1), seat("b", 10, 10, 1)]);
				expect(jobs(d)).toEqual(["old"]);
				expect(launched(d)).toEqual([]);
				expect(d).toMatchObject({
					skipped: [
						{
							root: "wfc",
							number: 7,
							why: "parked: its session's seat a is full",
						},
					],
				});
			});

			it("takes both with two fits to spare between them", () => {
				const d = beside([seat("a", 10, 10, 2)]);
				expect(jobs(d)).toEqual(["old"]);
				expect(launched(d)).toEqual(["wfc#7"]);
			});
		});

		it("says resumes take the slots when they take the last fit too", () => {
			const d = tick({
				freeSlots: 1,
				seats: [seat("a", 10, 10, 1)],
				resumable: [oldest],
			});
			expect(jobs(d)).toEqual(["old"]);
			expect(d).toMatchObject({
				idle: buildIdle("resumes take every free slot"),
			});
		});
	});

	it("keeps a run on spent seats alive for a resume due, as only a running loop makes it", () => {
		const spent = { seats: [seat("a", FULL, 10, null)] };
		expect(tick(spent)).toHaveProperty("planWait.resets", null);
		const d = tick({ ...spent, freeSlots: 2, resumable: [oldest] });
		expect(jobs(d)).toEqual(["old"]);
		expect(d).toMatchObject({
			launches: [],
			idle: buildIdle(
				"a plan resets",
				", its time unread; every seat is spent; a resume is due",
			),
		});
	});

	it("names each resume a stop leaves due", () => {
		const d = tick({ stopRequested: true, resumable: [oldest] });
		expect(d).toMatchObject({
			stop: "explicit",
			detail:
				"stop was requested; left with a resume due, acted on only by the next start: old held",
		});
		expect(d).not.toHaveProperty("resumes");
	});
});

describe("decideTick free slot", () => {
	it("launches into every free slot", () => {
		expect(launched(tick({ freeSlots: 2 }))).toEqual(["wfc#1", "wfc#2"]);
		expect(launched(tick({ freeSlots: 1 }))).toEqual(["wfc#1"]);
	});

	it("idles on no free slot where none is free", () => {
		expect(tick({ freeSlots: 0 })).toMatchObject({
			launches: [],
			idle: buildIdle("no free slot"),
		});
	});

	it("idles on the slot, not the seat, when none is free and every seat is unread (#2362)", () => {
		const unread = [seat("a", null, null, null), seat("b", null, null, null)];
		expect(tick({ freeSlots: 0, seats: unread })).toMatchObject({
			launches: [],
			idle: buildIdle("no free slot"),
		});
	});

	it("names an unsized seat over an unread one behind it, which was never probed (#2362)", () => {
		const d = tick({
			seats: [seat("a", 40, 20, null), seat("b", null, null, null)],
		});
		expect(d).toMatchObject({
			launches: [],
			idle: buildIdle("no plan has room right now"),
		});
	});

	it("idles on the cap where it fits no launch on any seat with room (#2362, #2432)", () => {
		const d = tick({
			seats: [seat("a", 98, 20, 0), seat("b", 100, 10), seat("c", 10, 10, 0)],
		});
		expect(d).not.toHaveProperty("stop");
		expect(d).toMatchObject({
			launches: [],
			idle: buildIdle("no plan has room right now"),
		});
	});

	it("names a failed shortlist and its reason, not an empty frontier, where nothing launched (#2561)", () => {
		const failedShortlists = [
			{ root: "/home/u/workflow-core", error: "exited 1 FAILED: offline" },
		];
		expect(tick({ frontier: [], failedShortlists })).toMatchObject({
			launches: [],
			idle: buildIdle(
				"shortlist failed in",
				" workflow-core: exited 1 FAILED: offline",
			),
		});
		expect(
			tick({ frontier: [row("wfc", 1, "human")], failedShortlists }),
		).toMatchObject({
			idle: buildIdle(
				"shortlist failed in",
				" workflow-core: exited 1 FAILED: offline",
			),
		});
		expect(tick({ frontier: [] })).toMatchObject({
			idle: buildIdle("nothing launchable"),
		});
	});

	it("launches what the read checkouts hold despite another's failed shortlist (#2561)", () => {
		const d = tick({
			failedShortlists: [{ root: "/home/u/other", error: "exited 1" }],
		});
		expect(launched(d)).toEqual(["wfc#1", "wfc#2"]);
		expect(d).toMatchObject({ idle: null });
	});

	it("idles on the unread seats where a slot is free (#2362)", () => {
		const d = tick({
			freeSlots: 2,
			seats: [seat("a", null, null, null), seat("b", null, null, null)],
		});
		expect(d).toMatchObject({
			launches: [],
			idle: buildIdle("no plan has room right now"),
		});
	});
});

describe("decideTick's unproven-launch cap (#4223)", () => {
	const Act = NOW - HOUR;
	const running = (jobId: string, launchedAt: number, over = {}) => ({
		root: "wfc",
		issues: [90],
		jobId,
		launchedAt,
		finishedAt: null,
		...over,
	});
	const sinceAct = (n: number) =>
		Array.from({ length: n }, (_, i) => running(`j${i}`, Act + 1 + i));
	const capIdle = buildIdle(
		"3 launches since the last act are running",
		` (last act ${new Date(Act).toISOString()})`,
	);

	it("launches none past three running since the last act, whatever the free slots", () => {
		const d = tick({ freeSlots: 5, history: sinceAct(3), lastActAt: Act });
		expect(d).toMatchObject({ launches: [], idle: capIdle });
	});

	it("fills only the cap's room where fewer than three run unproven", () => {
		const d = tick({ freeSlots: 5, history: sinceAct(1), lastActAt: Act });
		expect(launched(d)).toEqual(["wfc#1", "wfc#2"]);
	});

	it("counts nothing launched before the last act, so an act frees the cap", () => {
		const proven = [0, 1, 2].map((i) => running(`p${i}`, Act - 1 - i));
		const d = tick({ freeSlots: 3, history: proven, lastActAt: Act });
		expect(launched(d)).toEqual(["wfc#1", "wfc#2", "wfc#3"]);
	});

	it("counts a launch resumed since the last act, and passes over finished and park-stopped ones", () => {
		const history = [
			running("r", Act - HOUR, { relaunchedAt: Act + 1 }),
			running("f", Act + 1, { finishedAt: NOW - 1 }),
			running("p", Act + 1, { parkStopped: Act + 2 }),
		];
		const d = tick({ freeSlots: 5, history, lastActAt: Act });
		expect(launched(d)).toEqual(["wfc#1", "wfc#2"]);
	});

	it("passes over a launch stopped on its seat's limit until a resume restarts it", () => {
		const stopped = running("s", Act + 1, { limitHeld: {} });
		const resumed = running("r", Act + 1, {
			limitHeld: { resumedAt: Act + 2 },
		});
		const free = (history: unknown[]) =>
			launched(tick({ freeSlots: 5, history, lastActAt: Act })).length;
		expect(free([...sinceAct(2), stopped])).toBe(1);
		expect(free([...sinceAct(2), resumed])).toBe(0);
	});

	it("holds every running launch unproven where no act reads", () => {
		const d = tick({
			freeSlots: 5,
			history: [0, 1, 2].map((i) => running(`j${i}`, NOW - 10 * HOUR + i)),
			lastActAt: null,
		});
		expect(d).toMatchObject({
			launches: [],
			idle: buildIdle(
				"3 launches since the last act are running",
				" (no act read)",
			),
		});
	});

	it("counts a resume against the cap, and names the cap where resumes take its room", () => {
		const due = (jobId: string) => ({
			jobId,
			seat: "~/.claude3",
			root: "wfc",
			at: NOW - HOUR,
			line: `${jobId} held`,
		});
		const d = tick({
			freeSlots: 5,
			history: [...sinceAct(1), running("held", Act + 9)],
			resumable: [due("held"), due("other")],
			lastActAt: Act,
		});
		expect(d.resumes.map((r: { jobId: string }) => r.jobId)).toEqual([
			"held",
			"other",
		]);
		expect(d).toMatchObject({ launches: [], idle: capIdle });
	});

	it("leaves the no-free-slot idle to admission where it is the tighter", () => {
		expect(
			tick({ freeSlots: 0, history: sinceAct(3), lastActAt: Act }),
		).toMatchObject({ idle: buildIdle("no free slot") });
	});

	it("is a wait the queue moves through, not one the idle alarm names", () => {
		expect(buildLoopWait(capIdle)).toBeNull();
	});
});

describe("decideTick launch filter", () => {
	it("never launches human, children, waiting:external, parked or label-faulty rows", () => {
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
				row("wfc", 8, "triage"),
				row("wfc", 9, "wayfinder", {
					labels: ["takes:wayfinder", "wayfinder:grilling"],
				}),
			],
		});
		expect(launched(d)).toEqual(["wfc#8", "wfc#9"]);
		expect(d.skipped.map((s: { number: number }) => s.number)).toEqual([
			1, 2, 3, 4, 5, 6,
		]);
	});

	it("checks first where the row's latest /implement launch committed and did not close (#3782)", () => {
		const d = tick({
			freeSlots: 1,
			frontier: [row("wfc", 1)],
			history: [finished(1, { prompt: "/implement 1", acts: { commit: 1 } })],
		});
		expect(d.launches).toEqual([
			expect.objectContaining({
				issues: [1],
				prompt: buildVerifyPrompt(1),
			}),
		]);
	});

	it("hands back plain /implement once a later launch left the row open (#3782)", () => {
		const d = tick({
			freeSlots: 1,
			frontier: [row("wfc", 1)],
			history: [
				finished(1, { prompt: "/implement 1", acts: { commit: 1 } }),
				finished(1, { prompt: buildVerifyPrompt(1), acts: {} }),
			],
		});
		expect(d.launches[0].prompt).toBe("/implement 1");
	});

	it("launches a relabelled row on its own command, whatever its last launch did (#3782)", () => {
		const d = tick({
			freeSlots: 1,
			frontier: [row("wfc", 1, "triage")],
			history: [finished(1, { prompt: "/implement 1", acts: { commit: 1 } })],
		});
		expect(d.launches[0].prompt).toBe("/triage 1");
	});

	it("launches a map at any kind, an exhausted takes:wayfinder map as /wayfinder (#2639, #3569)", () => {
		/* One tick a kind: the unproven cap launches three at most (#4223). */
		const ticks = ["to-spec", "to-tickets", "implement", "wayfinder"].map(
			(k, i) =>
				tick({
					frontier: [
						row("wfc", 1 + i, k, { labels: [`takes:${k}`, "wayfinder:map"] }),
					],
				}),
		);
		expect(ticks.map((d) => d.launches[0].prompt)).toEqual([
			"/to-spec 1",
			"/to-tickets 2",
			"/implement 3",
			"/wayfinder 4",
		]);
		expect(ticks.flatMap((d) => d.skipped)).toEqual([]);
	});

	it("prompts each launchable kind with its own command, every one on Opus", () => {
		const kinds = ["implement", "wayfinder", "to-spec", "to-tickets", "triage"];
		/* One tick a kind: the unproven cap launches three at most (#4223). */
		const launches = kinds.map(
			(k, i) => tick({ frontier: [row("wfc", 10 + i, k)] }).launches[0],
		);
		expect(
			launches.map((l: { prompt: string; model: string }) => [
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
			{ root: "wfc", number: 1, why: "already running" },
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
			{ root: "wfc", number: 3, why: "already running" },
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

describe("decideTick on parked rows (#3621)", () => {
	const parked = (number: number, parkedAt: string | null) =>
		row("wfc", number, "implement", {
			labels: ["takes:implement", "parked"],
			parkedAt,
		});
	const frontier = [
		row("wfc", 1),
		parked(2, "2026-10-18T09:00:00Z"),
		parked(3, "2026-10-17T09:00:00Z"),
	];

	it("launches parked rows first in normal mode, oldest park first, each carrying its route", () => {
		const d = tick({ mode: "normal", freeSlots: 9, frontier });
		expect(launched(d)).toEqual(["wfc#3", "wfc#2", "wfc#1"]);
		const unread = { afresh: "no session that parked it is recorded" };
		expect(
			d.launches.map((l: { parkedRoute?: unknown }) => l.parkedRoute),
		).toEqual([unread, unread, undefined]);
	});

	it("gives the one free slot to a parked row over a higher-ranked one (#3872)", () => {
		const d = tick({
			mode: "normal",
			freeSlots: 1,
			frontier: [row("wfc", 1), parked(2, "2026-10-18T09:00:00Z")],
			seats: [seat("/s1", 10, 10)],
			parkers: [
				{
					root: "wfc",
					number: 2,
					sessionId: "s-2",
					job: { seat: "/s1", jobId: "j-2" },
					resumeCwd: "wfc",
				},
			],
		});
		expect(launched(d)).toEqual(["wfc#2"]);
		expect(d.launches[0].parkedRoute).toEqual({
			resume: { seat: "/s1", sessionId: "s-2", cwd: "wfc" },
		});
	});

	it("leaves a row whose label has gone in its rank, resuming nothing though a marker still lists it (#3872)", () => {
		const d = tick({
			mode: "normal",
			freeSlots: 9,
			frontier: [row("wfc", 1), row("wfc", 2)],
			parkers: [
				{
					root: "wfc",
					number: 2,
					sessionId: "s-2",
					job: { seat: "/s1", jobId: "j-2", cwd: "wfc" },
					resumeCwd: "wfc",
				},
			],
		});
		expect(launched(d)).toEqual(["wfc#1", "wfc#2"]);
		expect(
			d.launches.map((l: { parkedRoute?: unknown }) => l.parkedRoute),
		).toEqual([undefined, undefined]);
	});

	it("puts an unreadable park start first, as the oldest", () => {
		const d = tick({
			mode: "normal",
			freeSlots: 9,
			frontier: [...frontier, parked(4, null)],
		});
		/* The unproven cap stops the walk at three (#4223). */
		expect(launched(d)).toEqual(["wfc#4", "wfc#3", "wfc#2"]);
	});

	const judgement = { root: "wfc", number: 7, prompt: "/triage 7" };

	it("launches parked rows ahead of gate judgements in normal mode, judgements ahead of the rest (#3713)", () => {
		const one = tick({
			mode: "normal",
			freeSlots: 1,
			frontier: [parked(2, "2026-10-18T09:00:00Z")],
			judgements: [judgement],
		});
		expect(launched(one)).toEqual(["wfc#2"]);
		const d = tick({
			mode: "normal",
			freeSlots: 2,
			frontier: [row("wfc", 1), parked(2, "2026-10-18T09:00:00Z")],
			judgements: [judgement],
		});
		expect(launched(d)).toEqual(["wfc#2", "wfc#7"]);
	});

	it("walks a parked row behind its own issue's queued judgement (#3713)", () => {
		const d = tick({
			mode: "normal",
			freeSlots: 9,
			frontier: [parked(2, "2026-10-18T09:00:00Z"), parked(7, null)],
			judgements: [judgement],
		});
		expect(launched(d)).toEqual(["wfc#2", "wfc#7"]);
		expect(d.launches[1].gate).toBe(true);
		expect(d.skipped).toEqual([
			{ root: "wfc", number: 7, why: "already running" },
		]);
	});

	it("skips parked rows in away mode, gate judgements still first (#2355, #3713)", () => {
		const d = tick({
			mode: "away",
			freeSlots: 9,
			frontier,
			judgements: [judgement],
		});
		expect(launched(d)).toEqual(["wfc#7", "wfc#1"]);
		expect(d.skipped).toEqual([
			{ root: "wfc", number: 2, why: "parked" },
			{ root: "wfc", number: 3, why: "parked" },
		]);
	});

	it("launches an untyped takes:wayfinder ticket, as the morning review is filed, parked or not", () => {
		const review = (n: number, labels: string[]) =>
			row("wfc", n, "wayfinder", { labels: ["takes:wayfinder", ...labels] });
		const d = tick({
			mode: "normal",
			freeSlots: 9,
			frontier: [review(5, []), review(6, ["parked"])],
		});
		expect(d.launches.map((l: { prompt: string }) => l.prompt)).toEqual([
			"/wayfinder 6",
			"/wayfinder 5",
		]);
	});
});

describe("decideTick on a parked row's session seat (#3669)", () => {
	const parked = row("wfc", 2, "implement", {
		labels: ["takes:implement", "parked"],
		parkedAt: "2026-10-18T09:00:00Z",
	});
	const job = { seat: "/s2", jobId: "j2" };
	const parker = (over: Record<string, unknown> = {}) => ({
		root: "wfc",
		number: 2,
		job,
		sessionId: "s-2",
		resumeCwd: "wfc",
		...over,
	});
	const on = (s2: ReturnType<typeof seat>, parkers = [parker()]) =>
		tick({
			mode: "normal",
			freeSlots: 1,
			frontier: [parked, row("wfc", 1)],
			seats: [seat("/s1", 10, 10), s2],
			parkers,
		});

	it("holds resumes to their own seat's cap within one tick, naming no held ticket for the idle alarm (#3872)", () => {
		const at = (number: number) => ({
			...row("wfc", number, "implement", {
				labels: ["takes:implement", "parked"],
				parkedAt: `2026-10-1${number}T09:00:00Z`,
			}),
		});
		const d = tick({
			mode: "normal",
			freeSlots: 3,
			frontier: [at(2), at(3), row("wfc", 1)],
			seats: [seat("/s1", 10, 10), seat("/s2", 40, 20, 1)],
			parkers: [parker(), parker({ number: 3, sessionId: "s-3" })],
		});
		expect(launched(d)).toEqual(["wfc#2", "wfc#1"]);
		expect(d.skipped).toEqual([
			{ root: "wfc", number: 3, why: "parked: its session's seat /s2 is full" },
		]);
		expect(d.held).toEqual([]);
	});

	it("holds a row whose session's seat is full, its slot going to the next row, and resumes it once the seat has room", () => {
		for (const full of [
			seat("/s2", 100, 10),
			seat("/s2", 40, 100),
			seat("/s2", 40, 20, 0),
		]) {
			const d = on(full);
			expect(launched(d)).toEqual(["wfc#1"]);
			expect(d.skipped).toEqual([
				{
					root: "wfc",
					number: 2,
					why: "parked: its session's seat /s2 is full",
				},
			]);
		}
		/* Unsized, as every seat behind the first with room is. */
		const d = on(seat("/s2", 40, 20, null));
		expect(launched(d)).toEqual(["wfc#2"]);
		expect(d.launches[0].parkedRoute).toEqual({
			resume: { seat: "/s2", sessionId: "s-2", cwd: "wfc" },
		});
	});

	it("names a held row for the idle alarm though the slots fill before the walk reaches it (#3680)", () => {
		const full = seat("/s2", 100, 10);
		const older = row("wfc", 4, "implement", {
			labels: ["takes:implement", "parked"],
			parkedAt: "2026-10-17T09:00:00Z",
		});
		const d = tick({
			mode: "normal",
			freeSlots: 1,
			frontier: [parked, older, row("wfc", 1)],
			seats: [seat("/s1", 10, 10), full],
			parkers: [parker(), parker({ number: 4, job: { seat: "/s1" } })],
		});
		expect(launched(d)).toEqual(["wfc#4"]);
		expect(d.skipped).toEqual([]);
		expect(d.held).toEqual([
			{ root: "wfc", number: 2, why: "parked: its session's seat /s2 is full" },
		]);
		expect(on(seat("/s2", 40, 20, null)).held).toEqual([]);
	});

	it("names a held row for the idle alarm on a tick with no slot free (#3919)", () => {
		const d = tick({
			mode: "normal",
			freeSlots: 0,
			frontier: [parked],
			seats: [seat("/s1", 10, 10), seat("/s2", 100, 10)],
			parkers: [parker()],
		});
		expect(d).toMatchObject({ idle: buildIdle("no free slot"), launches: [] });
		expect(d.held).toEqual([
			{ root: "wfc", number: 2, why: "parked: its session's seat /s2 is full" },
		]);
	});

	describe("in away mode (#3850)", () => {
		const away = (s2: ReturnType<typeof seat>) =>
			tick({
				mode: "away",
				freeSlots: 1,
				frontier: [parked],
				seats: [seat("/s1", 10, 10), s2],
				parkers: [parker()],
			});

		it("names a row on a full seat for the idle alarm, launching no parked row (#2355)", () => {
			const d = away(seat("/s2", 100, 10));
			expect(d.held).toEqual([
				{
					root: "wfc",
					number: 2,
					why: "parked: its session's seat /s2 is full",
				},
			]);
			expect(launched(d)).toEqual([]);
			expect(d.skipped).toEqual([{ root: "wfc", number: 2, why: "parked" }]);
		});

		it("names none once the seat has room: a parked question stays excluded", () => {
			const d = away(seat("/s2", 40, 20, null));
			expect(d.held).toEqual([]);
			expect(d.skipped).toEqual([{ root: "wfc", number: 2, why: "parked" }]);
		});
	});

	describe("a ticket parked at a limit cap (#3804)", () => {
		const room = seat("/s2", 40, 20, null);

		it("holds it at the cap in a row, its slot going to the next row, and leaves its reporting to the idle alarm's read of its marker (#3840)", () => {
			const d = on(room, [parker({ limitParks: LIMIT_PARK_CAP })]);
			expect(launched(d)).toEqual(["wfc#1"]);
			const why = `parked: ${buildLimitCapText(LIMIT_PARK_CAP)}`;
			expect(d.skipped).toEqual([{ root: "wfc", number: 2, why }]);
			expect(d.held).toEqual([]);
		});

		it("holds it however its session would have routed", () => {
			const d = on(room, [parker({ limitParks: LIMIT_PARK_CAP, job: null })]);
			expect(launched(d)).toEqual(["wfc#1"]);
		});

		it("resumes it short of the cap, the route carrying the count on", () => {
			const d = on(room, [parker({ limitParks: LIMIT_PARK_CAP - 1 })]);
			expect(launched(d)).toEqual(["wfc#2"]);
			expect(d.launches[0].parkedRoute).toEqual({
				resume: { seat: "/s2", sessionId: "s-2", cwd: "wfc" },
				limitParks: LIMIT_PARK_CAP - 1,
			});
		});

		it("carries the block its marker names on to the resume (#3949)", () => {
			const d = on(room, [parker({ parkCause: "PERMISSION" })]);
			expect(d.launches[0].parkedRoute).toEqual({
				resume: {
					seat: "/s2",
					sessionId: "s-2",
					cwd: "wfc",
					parkCause: "PERMISSION",
				},
			});
		});

		it("still resumes a ticket parked on a question, its marker counting nothing", () => {
			const d = on(room);
			expect(launched(d)).toEqual(["wfc#2"]);
			expect(d.held).toEqual([]);
		});
	});

	it("launches a row whose parked label has gone on its takes: command, though a marker still lists it (#3872)", () => {
		const unlabelled = row("wfc", 2, "implement", { parkedAt: null });
		const d = tick({
			mode: "normal",
			freeSlots: 1,
			frontier: [unlabelled],
			seats: [seat("/s1", 10, 10), seat("/s2", 40, 20, null)],
			parkers: [parker()],
		});
		expect(launched(d)).toEqual(["wfc#2"]);
		expect(d.launches[0]).not.toHaveProperty("parkedRoute");
		expect(d.launches[0].prompt).toBe("/implement 2");
	});

	it("routes it afresh where no resume is possible: no parker, a marker naming no job, or a seat the loop does not read", () => {
		const full = seat("/s2", 100, 10);
		const afresh = (d: ReturnType<typeof tick>) => d.launches[0].parkedRoute;
		expect(afresh(on(full, []))).toEqual({
			afresh: "no session that parked it is recorded",
		});
		expect(afresh(on(full, [parker({ job: null })]))).toEqual({
			afresh: "its session s-2's marker names no job",
		});
		expect(
			afresh(on(full, [parker({ job: { ...job, seat: "/gone" } })])),
		).toEqual({ afresh: "its session's seat /gone is not one the loop reads" });
	});

	describe("a session parked on an overflow seat sharing a plan seat's dir (#4147)", () => {
		const onKey = parker({ job: { ...job, keyVar: "K2" } });

		it("routes it afresh, never to the plan seat's resume", () => {
			const d = on(seat("/s2", 40, 20, null), [onKey]);
			expect(d.launches[0].parkedRoute).toEqual({
				afresh: "its session ran on overflow seat key=K2",
			});
		});

		it("holds it on no reading of the plan seat, full as that seat reads", () => {
			const d = on(seat("/s2", 100, 10), [onKey]);
			expect(d.held).toEqual([]);
			expect(d.launches[0].parkedRoute).toEqual({
				afresh: "its session ran on overflow seat key=K2",
			});
		});

		it("still resumes a marker naming no key on that seat, as a plan seat's", () => {
			const d = on(seat("/s2", 40, 20, null), [parker()]);
			expect(d.launches[0].parkedRoute).toMatchObject({
				resume: { seat: "/s2" },
			});
		});
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

describe("decideTick on a predicted write-set clash (#4355)", () => {
	const writes = (...writeSet: string[]) => ({ writeSet });

	it("skips a row sharing a file with a launch this tick for the next row", () => {
		const d = tick({
			frontier: [
				row("wfc", 1, "implement", writes("scripts/a.js")),
				row("wfc", 2, "implement", writes("scripts/a.js", "scripts/b.js")),
				row("wfc", 3, "implement", writes("scripts/c.js")),
			],
		});
		expect(launched(d)).toEqual(["wfc#1", "wfc#3"]);
		expect(d.skipped).toEqual([
			{
				root: "wfc",
				number: 2,
				why: "clashes on scripts/a.js with #1 launched this tick",
			},
		]);
	});

	it("skips a row whose file a running session holds", () => {
		const d = tick({
			frontier: [
				row("wfc", 1, "implement", {
					...writes("scripts/a.js"),
					heldBy: {
						paths: ["scripts/a.js"],
						session: "Implement 9",
						sessionId: "s-9",
					},
				}),
				row("wfc", 2),
				row("wfc", 3),
			],
		});
		expect(launched(d)).toEqual(["wfc#2", "wfc#3"]);
		expect(d.skipped).toEqual([
			{
				root: "wfc",
				number: 1,
				why: "clashes on scripts/a.js held by Implement 9",
			},
		]);
	});

	it("resumes a parked row onto files its own parked session holds", () => {
		const d = tick({
			mode: "normal",
			freeSlots: 1,
			seats: [seat("/s1", 10, 10)],
			frontier: [
				row("wfc", 2, "implement", {
					labels: ["takes:implement", "parked"],
					parkedAt: "2026-10-18T09:00:00Z",
					...writes("scripts/a.js"),
					heldBy: {
						paths: ["scripts/a.js"],
						session: "Implement 2",
						sessionId: "s-2",
					},
				}),
				row("wfc", 1),
			],
			parkers: [
				{
					root: "wfc",
					number: 2,
					sessionId: "s-2",
					job: { seat: "/s1", jobId: "j-2" },
					resumeCwd: "wfc",
				},
			],
		});
		expect(launched(d)).toEqual(["wfc#2"]);
		expect(d.skipped).toEqual([]);
	});

	it("never skips on a shared stamp path", () => {
		const d = tick({
			frontier: [
				row("wfc", 1, "implement", writes("docs/doc-map.md", "CLAUDE.md")),
				row("wfc", 2, "implement", writes("docs/doc-map.md", "CLAUDE.md")),
			],
		});
		expect(launched(d)).toEqual(["wfc#1", "wfc#2"]);
		expect(d.skipped).toEqual([]);
	});

	it("reads one file in two checkouts as no clash", () => {
		const d = tick({
			frontier: [
				row("wfc", 1, "implement", writes("scripts/a.js")),
				row("other", 2, "implement", writes("scripts/a.js")),
			],
		});
		expect(launched(d)).toEqual(["wfc#1", "other#2"]);
	});

	it("still fills every slot, in rank order, where only clashing rows remain", () => {
		const d = tick({
			freeSlots: 3,
			frontier: [
				row("wfc", 1, "implement", writes("scripts/a.js")),
				row("wfc", 2, "implement", {
					...writes("scripts/b.js"),
					heldBy: {
						paths: ["scripts/b.js"],
						session: "Implement 9",
						sessionId: "s-9",
					},
				}),
				row("wfc", 3, "implement", writes("scripts/a.js")),
				row("wfc", 4, "implement", writes("scripts/a.js")),
			],
		});
		expect(launched(d)).toEqual(["wfc#1", "wfc#2", "wfc#3"]);
		expect(d.skipped).toEqual([
			{
				root: "wfc",
				number: 4,
				why: "clashes on scripts/a.js with #1 launched this tick",
			},
		]);
	});
});

describe("readParkers (#3773)", () => {
	const Other = "/home/u/other";
	const Wfc = "/home/u/wfc";
	const parked = (root: string, number: number) =>
		row(root, number, "implement", {
			labels: ["takes:implement", "parked"],
		});
	const marker = (
		sessionId: string,
		writtenAt: number,
		cwd: string | null,
	) => ({
		issues: [5],
		sessionId,
		writtenAt,
		job: { seat: "/s2", jobId: `j-${sessionId}`, cwd },
	});

	it("takes the newest marker listing a parked row, resuming in its cwd, else the checkout holding it", () => {
		const read: string[] = [];
		const readMarkers = (root: string) => {
			read.push(root);
			return root === Wfc
				? [marker("s-old", 1, "/old"), marker("s-new", 2, "/new")]
				: [{ ...marker("s-o", 1, null), limitParks: 2, cause: "LIMIT" }];
		};
		const frontier = [
			parked(Wfc, 5),
			{ ...parked(Wfc, 5), number: 6 },
			row(Wfc, 5),
			parked(Other, 5),
			parked(Wfc, 5),
		] as never;
		expect(readParkers(frontier, readMarkers)).toEqual([
			expect.objectContaining({
				root: Wfc,
				sessionId: "s-new",
				resumeCwd: "/new",
			}),
			{
				root: Other,
				number: 5,
				sessionId: "s-o",
				job: { seat: "/s2", jobId: "j-s-o", cwd: null },
				resumeCwd: Other,
				limitParks: 2,
				parkCause: "LIMIT",
			},
			expect.objectContaining({ root: Wfc, sessionId: "s-new" }),
		]);
		expect(read).toEqual([Wfc, Other]);
	});
});
