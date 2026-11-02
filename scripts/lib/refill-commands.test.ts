// @vitest-environment node
/*
 * What the refill loop's `start` writes over a running loop's scope (#2123)
 * and what its `status` prints (#2012, #2561, #2850, #2659).
 *
 * Loosen one and a /pick-next start silently narrows or prolongs a running
 * away mode, or `status` hides a launch that waits on the founder or on the
 * loop's resumes or hand-off.
 */

import { describe, expect, it } from "vitest";
import {
	buildSeatsLine,
	buildSeatsView,
	buildSetPlanJson,
	buildStatusJson,
	buildStatusLines,
	foreseeSeat,
	planSet,
	planStart,
} from "./refill-commands.js";
import {
	buildPausedWaitText,
	buildPauseText,
	QUIET_BENCH_PAUSE,
} from "./refill-decide.js";
import { parseState } from "./refill-loop.js";
import {
	away,
	DV,
	issuesGoal,
	type Launch,
	MH,
	MIN,
	NOW,
	normal,
	record,
	WFC,
} from "./refill-loop-fixture";

const NO_SEATS = {
	readings: [],
	next: null,
	wait: "every seat is spent",
	passedOver: [],
	callerSeat: null,
};

describe("what status prints", () => {
	const control = {
		noProgressFrom: NOW - 60 * MIN,
		stopRequested: false,
		seats: ["/home/u/.claude3", "/home/u/.claude2"],
		scope: normal(
			[WFC, MH],
			issuesGoal(["workflow-core", 116], ["workflow-core", 117]),
		),
	};
	const state = {
		launches: [
			record({
				launchedAt: NOW - 150 * MIN,
				prompt: "/implement 2",
				finishedAt: NOW - 100 * MIN,
			}),
			record({ launchedAt: NOW - 120 * MIN, prompt: "/implement 1" }),
			record({ launchedAt: NOW - 30 * MIN, finishedAt: NOW }),
		],
		lastTick: { at: NOW, summary: "idle: no free slot" },
		stopped: {
			at: NOW - 200 * MIN,
			reason: "control-damaged",
			detail: "/c is damaged",
		},
		held: [],
		reviewRunOn: null,
		launchCount: null,
		handedOff: null,
		launchDay: null,
		overflowStart: null,
		goalProgress: null,
		probeBrokenRoots: [],
	};
	const served = [WFC, MH];

	it("gives start and launches since the start, with no stop older than the run", () => {
		const out = buildStatusLines({
			seats: NO_SEATS,
			now: NOW,
			control,
			state,
			pid: 123,
			served,
		}).join("\n");
		expect(out).toContain("running, pid 123");
		expect(out).toContain(
			`counting:  no-progress count from ${new Date(control.noProgressFrom).toISOString()}`,
		);
		expect(out).not.toContain("stops by");
		expect(out).toContain("launches:  1 since then, 1 running, 0 parked");
		expect(out).toContain("/implement 1  running");
		expect(out).not.toContain("/implement 2");
		expect(out).toContain("/implement 42  finished");
		expect(out).not.toContain("session ");
		expect(out).toContain("idle: no free slot");
		expect(out).not.toContain("last stop:");
	});
	it("gives the last stop where no process runs", () => {
		const out = buildStatusLines({
			seats: NO_SEATS,
			now: NOW,
			control,
			state,
			pid: null,
			served,
		}).join("\n");
		expect(out).toContain("last stop:");
		expect(out).toContain("control-damaged — /c is damaged");
		expect(out).not.toContain("died:");
	});
	it("counts a park the loop stopped as parked, and says it stopped it (#2699)", () => {
		const stopped = record({
			launchedAt: NOW - 20 * MIN,
			prompt: "/implement 9",
			finishedAt: NOW,
			parkStopped: NOW - MIN,
		});
		const out = buildStatusLines({
			seats: NO_SEATS,
			now: NOW,
			control,
			state: { ...state, launches: [...state.launches, stopped] },
			pid: 123,
			served,
		}).join("\n");
		expect(out).toContain("launches:  2 since then, 1 running, 1 parked");
		expect(out).toContain("/implement 9  parked, stopped");
	});

	it("lists the last tick's skipped rows, ten and a count past them (#2561)", () => {
		const skipped = Array.from({ length: 12 }, (_, i) => ({
			root: WFC,
			number: 100 + i,
			why: i === 0 ? "parked" : "already running",
		}));
		const lines = buildStatusLines({
			seats: NO_SEATS,
			now: NOW,
			control,
			state: {
				...state,
				lastTick: { at: NOW, summary: "idle: nothing launchable", skipped },
			},
			pid: 123,
			served,
		});
		const listed = lines.filter((l) => l.startsWith("  skipped "));
		expect(listed).toHaveLength(10);
		expect(listed[0]).toBe("  skipped workflow-core #100 parked");
		expect(lines).toContain("  … and 2 more skipped");
	});

	it("reads back only well-formed skipped rows from the state file", () => {
		const parsed = parseState({
			lastTick: {
				at: NOW,
				summary: "idle: nothing launchable",
				skipped: [
					{ root: WFC, number: 1, why: "parked" },
					{ root: WFC, number: "2", why: "parked" },
					null,
				],
			},
		});
		expect(parsed.lastTick?.skipped).toEqual([
			{ root: WFC, number: 1, why: "parked" },
		]);
		expect(parseState({ lastTick: { at: NOW } }).lastTick).toBeNull();
	});

	it("shows a launch's session id where captured (#2311)", () => {
		const out = buildStatusLines({
			seats: NO_SEATS,
			now: NOW,
			control,
			state: {
				...state,
				launches: [record({ launchedAt: NOW, sessionId: "sess-9" })],
			},
			pid: 123,
			served,
		}).join("\n");
		expect(out).toContain(
			"/implement 42  running  on /home/u/.claude3  session sess-9",
		);
	});

	it("names the mode, the repos and the goal", () => {
		const out = buildStatusLines({
			seats: NO_SEATS,
			now: NOW,
			control,
			state,
			pid: 123,
			served,
		}).join("\n");
		expect(out).toContain("mode:      normal");
		expect(out).toContain("repos:     workflow-core, mantahostels");
		expect(out).toContain(
			'goal:      issues "workflow-core#116,workflow-core#117": workflow-core#116, workflow-core#117',
		);
		const awayOut = buildStatusLines({
			seats: NO_SEATS,
			now: NOW,
			control: { ...control, scope: away([DV]) },
			state,
			pid: 123,
			served,
		}).join("\n");
		expect(awayOut).toContain("mode:      away");
		expect(awayOut).toContain("repos:     workflow-core, mantahostels");
		expect(awayOut).toContain("goal:      none");
	});

	it("says a requested stop is pending while the loop still runs", () => {
		const out = buildStatusLines({
			seats: NO_SEATS,
			now: NOW,
			control: { ...control, stopRequested: true },
			state,
			pid: 123,
			served,
		}).join("\n");
		expect(out).toContain("at its next tick, on request");
	});

	it("says when the loop is not running or never started", () => {
		const out = buildStatusLines({
			seats: NO_SEATS,
			now: NOW,
			control: null,
			state: {
				launches: [],
				lastTick: null,
				stopped: null,
				held: [],
				reviewRunOn: null,
				launchCount: null,
				handedOff: null,
				launchDay: null,
				overflowStart: null,
				goalProgress: null,
				probeBrokenRoots: [],
			},
			pid: null,
			served: [],
		});
		expect(out).toEqual([
			"refill loop: not running",
			"never started on this machine",
		]);
	});
});

describe("the launch lines status shows (#2850)", () => {
	const statusOf = (launches: Launch[]) =>
		buildStatusLines({
			seats: NO_SEATS,
			now: NOW,
			control: {
				noProgressFrom: NOW - 60 * MIN,
				stopRequested: false,
				seats: [],
				scope: normal([DV]),
			},
			state: {
				launches,
				lastTick: null,
				stopped: null,
				held: [],
				reviewRunOn: null,
				launchCount: null,
				handedOff: null,
				launchDay: null,
				overflowStart: null,
				goalProgress: null,
				probeBrokenRoots: [],
			},
			pid: 1,
			served: [DV],
		}).join("\n");

	it("shows a resumed-idle launch's idle start, and its resumes once made", () => {
		expect(statusOf([record({ idleSince: NOW - 3 * MIN })])).toContain(
			"resumed-idle since 2026-10-18T11:57:00.000Z, not yet resumed",
		);
		expect(
			statusOf([
				record({
					idleSince: NOW - 9 * MIN,
					idleResumes: { tries: 1, triedAt: NOW - 4 * MIN },
				}),
			]),
		).toContain(
			"resumed-idle since 2026-10-18T11:51:00.000Z, resumed 1 times, last at 2026-10-18T11:56:00.000Z",
		);
	});

	it("shows a launch a restart killed (#3880)", () => {
		const bootKilled = { at: NOW, sessionId: "s", cwd: "/", tries: 0 };
		expect(statusOf([record({ bootKilled })])).toContain(
			"killed by a restart, resumed through admission",
		);
	});

	it("shows a launch stopped under the swap hold, and when (#3093)", () => {
		const swapHeld = { at: NOW - 6 * MIN, sessionId: "s", cwd: "/", tries: 0 };
		expect(statusOf([record({ swapHeld })])).toContain(
			"stopped under the swap hold since 2026-10-18T11:54:00.000Z, resumed through admission once it clears",
		);
	});

	it("shows a launch stopped on its seat's limit, past the launch window (#3735)", () => {
		const limitHeld = {
			at: NOW - 6 * MIN,
			sessionId: "s",
			cwd: "/",
			limit: { bar: "weekly", resets: "2026-10-20T00:00:00.000Z" },
		};
		expect(statusOf([record({ limitHeld })])).toContain(
			"stopped since 2026-10-18T11:54:00.000Z on its weekly limit (reset 2026-10-20T00:00:00.000Z), resumed once its seat reads under the cut",
		);
	});

	it("shows an API-error launch's tries and its next try's time", () => {
		const block = {
			cause: "API_ERROR",
			sub: "transient",
			since: NOW - 8 * MIN,
		};
		expect(statusOf([record({ block })])).toContain(
			"0 of 16 tries, next at 2026-10-18T11:52:00.000Z",
		);
		expect(
			statusOf([
				record({
					block,
					resumes: { tries: 2, triedAt: NOW - 2 * MIN, nextAt: NOW + 8 * MIN },
				}),
			]),
		).toContain("2 of 16 tries, next at 2026-10-18T12:08:00.000Z");
		expect(
			statusOf([
				record({
					block,
					resumes: {
						tries: 1,
						triedAt: NOW - MIN,
						nextAt: NOW + 4 * MIN,
						attachAt: NOW - MIN,
					},
				}),
			]),
		).toContain("1 of 16 tries, its typed resume being checked");
	});

	it("counts a resumed-idle launch as running", () => {
		expect(statusOf([record({ idleSince: NOW - MIN })])).toContain(
			"1 running, 0 parked",
		);
	});

	it("lists a parked, resuming, resumed-idle or hand-off-owed launch behind ten newer finished ones", () => {
		const newer = Array.from({ length: 10 }, (_, i) =>
			record({
				prompt: `/implement ${100 + i}`,
				launchedAt: NOW - (20 - i) * MIN,
				finishedAt: NOW - MIN,
			}),
		);
		const older = [
			record({
				prompt: "/implement 1",
				launchedAt: NOW - 50 * MIN,
				parked: true,
			}),
			record({
				prompt: "/implement 2",
				launchedAt: NOW - 49 * MIN,
				block: { cause: "API_ERROR", sub: "transient", since: NOW },
			}),
			record({
				prompt: "/implement 3",
				launchedAt: NOW - 48 * MIN,
				idleSince: NOW - MIN,
			}),
			record({
				prompt: "/implement 4",
				launchedAt: NOW - 47 * MIN,
				finishedAt: NOW,
			}),
			record({
				prompt: "/implement 5",
				launchedAt: NOW - 46 * MIN,
				parkStopped: NOW - MIN,
			}),
			record({
				prompt: "/implement 6",
				launchedAt: NOW - 45 * MIN,
				handOffTries: 1,
			}),
		];
		const out = statusOf([...older, ...newer]);
		for (const prompt of [
			"/implement 1  parked",
			"/implement 2",
			"/implement 3",
			"/implement 5  parked, stopped",
			"/implement 6",
		])
			expect(out).toContain(prompt);
		expect(out).not.toContain("/implement 4");
		expect(out).toContain("/implement 100");
	});
});

describe("a launch row's seat and reason (#3732)", () => {
	const control = {
		noProgressFrom: NOW - 60 * MIN,
		stopRequested: false,
		seats: [],
		scope: normal([DV]),
	};
	const stateOf = (launches: Launch[]) => ({
		launches,
		lastTick: null,
		stopped: null,
		held: [],
		reviewRunOn: null,
		launchCount: null,
		handedOff: null,
		launchDay: null,
		overflowStart: null,
		goalProgress: null,
		probeBrokenRoots: [],
	});
	const seat = `${process.env.HOME}/.claude2`;
	const typed = record({ seat, reason: "last typed on" });

	it("names the seat as a tilde path and why it was picked, in status", () => {
		const out = buildStatusLines({
			seats: NO_SEATS,
			now: NOW,
			control,
			state: stateOf([typed]),
			pid: 1,
			served: [DV],
		}).join("\n");
		expect(out).toContain("running  on ~/.claude2 (last typed on)");
	});

	it("reads moved from <seat> on a moved session's row, on the seat it went to (#3734)", () => {
		const moved = record({
			seat,
			reason: "moved from ~/.claude3",
		});
		const out = buildStatusLines({
			seats: NO_SEATS,
			now: NOW,
			control,
			state: stateOf([moved]),
			pid: 1,
			served: [DV],
		}).join("\n");
		expect(out).toContain("on ~/.claude2 (moved from ~/.claude3)");
	});

	it("gives the same seat and reason in status --json, null on an older record", () => {
		const json = buildStatusJson({
			seats: NO_SEATS,
			control,
			state: stateOf([typed, record({ seat })]),
			pid: 1,
			codeSha: null,
			today: "2026-11-02",
			candidates: [],
			burnMode: { on: false, disagreeing: [], error: null },
			overflow: [],
		});
		expect(json.running).toBe(true);
		expect(
			json.launches.map((l: { seat: string; reason: string | null }) => [
				l.seat,
				l.reason,
			]),
		).toEqual([
			["~/.claude2", "last typed on"],
			["~/.claude2", null],
		]);
	});
});

describe("status --json for the panel (#3873)", () => {
	const jsonOf = (state: object, today = "2026-11-02") =>
		buildStatusJson({
			seats: NO_SEATS,
			control: null,
			state: {
				launches: [],
				lastTick: null,
				stopped: null,
				held: [],
				reviewRunOn: null,
				launchCount: null,
				handedOff: null,
				launchDay: null,
				overflowStart: null,
				goalProgress: null,
				probeBrokenRoots: [],
				...state,
			},
			pid: 1,
			codeSha: "abc1234",
			today,
			candidates: [],
			burnMode: { on: false, disagreeing: [], error: null },
			overflow: [],
		});

	it("carries the code sha, and the last tick's summary and waiting reason", () => {
		const json = jsonOf({
			lastTick: { at: 5, summary: "idle: no free slot", idle: "no free slot" },
		});
		expect(json.codeSha).toBe("abc1234");
		expect(json.lastTick).toEqual({
			at: 5,
			summary: "idle: no free slot",
			idle: "no free slot",
			paused: false,
			planWait: null,
		});
	});

	it("marks a tick that idled on a pause, and says no stop is asked with no control", () => {
		const idle = buildPauseText({ by: "founder", at: 7 });
		const json = jsonOf({ lastTick: { at: 5, summary: "s", idle } });
		expect(json.lastTick?.paused).toBe(true);
		expect(json.stopRequested).toBe(false);
	});

	it("reads a tick with no waiting reason, and no tick, as null", () => {
		expect(jsonOf({}).lastTick).toBeNull();
		expect(
			jsonOf({ lastTick: { at: 5, summary: "launched" } }).lastTick?.idle,
		).toBeNull();
	});

	it("counts today's launches, and none from another day", () => {
		const launchDay = { day: "2026-11-01", count: 284 };
		expect(jsonOf({ launchDay }, "2026-11-01").launchesToday).toBe(284);
		expect(jsonOf({ launchDay }).launchesToday).toBe(0);
		expect(jsonOf({}).launchesToday).toBe(0);
	});
});

describe("a handed-off launch (#2659)", () => {
	it("reads a handed-off launch's state for status", () => {
		const out = buildStatusLines({
			seats: NO_SEATS,
			now: NOW,
			control: {
				noProgressFrom: NOW - 60 * MIN,
				stopRequested: false,
				seats: [],
				scope: normal([DV]),
			},
			state: {
				launches: [
					record({ finishedAt: NOW, handedOff: NOW, launchedAt: NOW - MIN }),
				],
				lastTick: null,
				stopped: null,
				held: [],
				reviewRunOn: null,
				launchCount: null,
				handedOff: null,
				launchDay: null,
				overflowStart: null,
				goalProgress: null,
				probeBrokenRoots: [],
			},
			pid: 1,
			served: [DV],
		}).join("\n");
		expect(out).toContain("handed off: stopped idle after its host's restart");
	});
});

describe("the seats: line (#3733)", () => {
	const ceilings = { week: 97, session: 90 };
	const seat = (
		dir: string,
		week: number | null,
		session: number | null,
		over: {
			fits?: number | null;
			weekResets?: number;
			fresh?: boolean;
			sessionResets?: string;
			weekRead?: { percent: number | null; atMs: number | null };
		} = {},
	) => ({
		seat: `${process.env.HOME}/${dir}`,
		week,
		session,
		weekFull: week === 100,
		sessionFull: session === 100,
		sessionResets: null,
		weekResets: null,
		readAt: NOW - 12 * MIN,
		weekRead: { percent: week, atMs: NOW },
		fits: 1,
		fresh: true,
		weekFresh: week !== null,
		...over,
	});
	const lineOf = (
		seats: Parameters<typeof buildSeatsView>[0]["seats"],
		typedSeat: string | null = null,
		rest: {
			overflow?: {
				seat: string;
				fits: number | null;
				spentUntil: null;
				why: null;
			}[];
			callerSeat?: string;
		} = {},
	) =>
		buildSeatsLine(
			buildSeatsView({
				seats,
				overflow: rest.overflow ?? [],
				typedSeat,
				ceilings,
				...(rest.callerSeat ? { callerSeat: rest.callerSeat } : {}),
			}),
			NOW,
		);

	it("gives readings, the last-typed pick and both limits failing on a seat passed over", () => {
		const typed = seat(".claude3", 40, 20);
		const spent = seat(".claude2", 98, 95, { fits: 0 });
		expect(lineOf([spent, typed], typed.seat)).toBe(
			"seats:     ~/.claude3 week 40% 5h 20%, ~/.claude2 week 98% 5h 95%; next ~/.claude3 (last typed on); passed over ~/.claude2 week 98% ≥ 97%, 5h 95% ≥ 90%",
		);
	});

	it("names only the limit that fails, and the soonest-reset reason", () => {
		const typed = seat(".claude3", 98, 20, { fits: 0 });
		const other = seat(".claude2", 40, 20);
		expect(lineOf([typed, other], typed.seat)).toBe(
			"seats:     ~/.claude3 week 98% 5h 20%, ~/.claude2 week 40% 5h 20%; next ~/.claude2 (soonest reset); passed over ~/.claude3 week 98% ≥ 97%",
		);
	});

	it("names a seat no limit fails on only where the walk passed it, saying why", () => {
		const capped = seat(".claude3", 80, 20, { fits: 0 });
		const unread = seat(".claude2", null, null, { fits: null, fresh: false });
		const open = seat(".claude4", 40, 20);
		const behind = seat(".claude5", 40, 20);
		expect(lineOf([capped, unread, open, behind])).toBe(
			"seats:     ~/.claude3 week 80% 5h 20%, ~/.claude2 week unread 5h unread, ~/.claude4 week 40% 5h 20%, ~/.claude5 week 40% 5h 20%; next ~/.claude4 (soonest reset); passed over ~/.claude3 cap fits no launch; passed over ~/.claude2 unread",
		);
	});

	it("says why no seat is next, listing every limit", () => {
		const a = seat(".claude3", 100, 95, { fits: null });
		expect(lineOf([a])).toBe(
			"seats:     ~/.claude3 week 100% 5h 95%; next none (every seat is spent); passed over ~/.claude3 week 100% ≥ 97%, 5h 95% ≥ 90%",
		);
	});

	it("takes an overflow seat once every plan seat is weekly-full", () => {
		const full = seat(".claude3", 100, 20, { fits: null });
		const overflow = [
			{
				seat: `${process.env.HOME}/.claude3-api`,
				fits: 2,
				spentUntil: null,
				why: null,
			},
		];
		expect(lineOf([full], null, { overflow })).toContain(
			"next ~/.claude3-api (overflow); passed over ~/.claude3 week 100% ≥ 97%",
		);
	});

	it("adds the seat /pick-next's own launches went on, for start", () => {
		const open = seat(".claude3", 40, 20);
		expect(
			lineOf([open], null, { callerSeat: `${process.env.HOME}/.claude2` }),
		).toBe(
			"seats:     ~/.claude3 week 40% 5h 20%; next ~/.claude3 (soonest reset); /pick-next's launches ~/.claude2 (its caller's seat)",
		);
	});

	it("marks a seat read off a stale cache with its age", () => {
		const stale = seat(".claude3", 40, 20, { fresh: false });
		expect(lineOf([stale])).toContain(
			"~/.claude3 week 40% 5h 20% (read 12m ago); next ~/.claude3",
		);
	});

	it("names each overflow seat the walk passed, once every plan seat is weekly-full", () => {
		const full = seat(".claude3", 100, 20, { fits: null });
		const dirOf = (name: string) => `${process.env.HOME}/${name}`;
		const row = (name: string, fits: number, spentUntil: string | null) => ({
			seat: dirOf(name),
			fits,
			spentUntil,
			why: null,
		});
		const overflow = [
			row(".claude2-api", 0, "2026-11-20"),
			row(".claude3-api", 2, null),
			row(".claude4-api", 2, null),
		];
		const out = buildSeatsLine(
			buildSeatsView({ seats: [full], overflow, typedSeat: null, ceilings }),
			NOW,
		);
		expect(out).toContain(
			"next ~/.claude3-api (overflow); passed over ~/.claude3 week 100% ≥ 97%; passed over ~/.claude2-api exhausted until 2026-11-20",
		);
		expect(out).not.toContain("~/.claude4-api");
	});

	it("leaves overflow seats out while a plan seat is not weekly-full", () => {
		const open = seat(".claude3", 40, 20);
		const overflow = [
			{
				seat: `${process.env.HOME}/.claude3-api`,
				fits: null,
				spentUntil: null,
				why: "a plan seat is not weekly-full",
			},
		];
		const view = buildSeatsView({
			seats: [open],
			overflow,
			typedSeat: null,
			ceilings,
		});
		expect(view.passedOver).toEqual([]);
	});

	it("gives a wait in tilde paths", () => {
		const held = seat(".claude3", 95, 100, {
			fits: null,
			sessionResets: "3pm",
		});
		const view = buildSeatsView({
			seats: [held],
			overflow: [],
			typedSeat: null,
			ceilings,
		});
		expect(view.wait).toBe(
			"the 5-hour bar is full on ~/.claude3 until its 5-hour reset 3pm",
		);
	});

	it("carries the week's last figure, read time and freshness on each reading", () => {
		const view = buildSeatsView({
			seats: [seat(".claude3", null, null, { fits: null, fresh: false })],
			overflow: [],
			typedSeat: null,
			ceilings,
		});
		expect(view.readings[0].weekRead).toEqual({
			percent: null,
			at: new Date(NOW).toISOString(),
			fresh: false,
		});
	});

	it("gives no read time on a week that carries none", () => {
		const unstamped = seat(".claude3", 100, null, {
			fits: null,
			fresh: false,
			weekRead: { percent: 100, atMs: null },
		});
		const view = buildSeatsView({
			seats: [unstamped],
			overflow: [],
			typedSeat: null,
			ceilings,
		});
		expect(view.readings[0].weekRead.at).toBeNull();
	});

	describe("a seat foreseen off its cache", () => {
		const reset = new Date(NOW + 60 * MIN).toISOString();
		const bar = (percent: number | null, trust: string, resetsAt = reset) => ({
			percent,
			severity: null,
			resetsAt,
			fetchedAtMs: NOW - 12 * MIN,
			trust,
		});
		it("keeps the week fresh with only the 5-hour bar stale", () => {
			const out = foreseeSeat({
				reading: seat(".claude3", 62, null),
				bars: {
					weekly_all: bar(62, "fresh"),
					session: bar(10, "stale"),
				} as never,
				sizeCap: () => 1,
				ceilings,
				now: NOW,
			});
			expect(out).toMatchObject({ fresh: false, weekFresh: true });
		});

		const foresee = (
			week: number | null,
			session: number | null,
			bars: { weekly_all: unknown; session: unknown },
			cap: number | null = 1,
		) => {
			const asked: string[] = [];
			const out = foreseeSeat({
				reading: seat(".claude3", week, session),
				bars: bars as never,
				sizeCap: () => {
					asked.push("cap");
					return cap;
				},
				ceilings,
				now: NOW,
			});
			return { out, asked };
		};
		const fresh = { weekly_all: bar(98, "fresh"), session: bar(20, "fresh") };

		it("sizes a fresh seat past the cut as a tick does, so the pick agrees", () => {
			const { out } = foresee(98, 20, fresh);
			expect(out.fits).toBe(1);
			const line = lineOf([out], out.seat);
			expect(line).toContain("next ~/.claude3 (last typed on)");
			expect(line).not.toContain("passed over");
		});

		it("passes over a fresh seat past the cut that the cap floors, naming the limit", () => {
			const { out } = foresee(98, 20, fresh, 0);
			expect(lineOf([out])).toContain("passed over ~/.claude3 week 98% ≥ 97%");
		});

		it("sizes no fresh seat with a full bar", () => {
			const { out, asked } = foresee(100, 20, fresh);
			expect(out.fits).toBeNull();
			expect(asked).toEqual([]);
		});

		it("counts a stale bar at its last percent, fitting under the cut", () => {
			const { out, asked } = foresee(null, null, {
				weekly_all: bar(40, "stale"),
				session: bar(20, "stale"),
			});
			expect(out).toMatchObject({
				week: 40,
				session: 20,
				fits: 1,
				fresh: false,
			});
			expect(asked).toEqual([]);
		});

		it("fits no launch on a stale bar past the cut", () => {
			const { out } = foresee(null, null, {
				weekly_all: bar(98, "stale"),
				session: bar(20, "stale"),
			});
			expect(out).toMatchObject({ week: 98, fits: 0, fresh: false });
		});

		it("reads a stale bar whose window has reset as unread", () => {
			const past = new Date(NOW - MIN).toISOString();
			const { out } = foresee(null, null, {
				weekly_all: bar(98, "stale", past),
				session: bar(20, "stale"),
			});
			expect(out).toMatchObject({ week: null, session: 20, fits: null });
		});
	});
});

describe("planSet's resume with no process (#3861)", () => {
	const control = {
		noProgressFrom: 5,
		stopRequested: false,
		seats: ["/seat"],
		scope: away(["/repo"], issuesGoal(["/repo", 7])),
	};
	const NowMs = 100;
	const resume = (over: Record<string, unknown>, running: boolean) =>
		planSet(
			{ control: { ...control, ...over }, damaged: null },
			{ pause: false },
			{ running, now: NowMs },
		);

	it.each([
		["crashed", {}],
		["stopped by command", { stopRequested: true, stopRequestedAt: 6 }],
		["paused", { paused: { by: "founder", at: 6 } }],
		[
			"paused and stopped",
			{ paused: { by: "founder", at: 6 }, stopRequested: true },
		],
	])("starts from the stored settings where it %s", (_name, over) => {
		const plan = resume(over, false);
		const expected = { ...control, noProgressFrom: NowMs };
		expect(plan).toMatchObject({ write: expected, startFrom: expected });
		const { write } = plan as { write: object };
		expect(write).not.toHaveProperty("paused");
		expect(write).not.toHaveProperty("stopRequestedAt");
	});

	it("starts nothing beside a running loop, paused or not", () => {
		expect(resume({ paused: { by: "founder", at: 6 } }, true)).toMatchObject({
			startFrom: null,
		});
		expect(resume({}, true)).toMatchObject({ write: null, startFrom: null });
	});
});

describe("the quiet bench route's setting and hold (#3852)", () => {
	const control = {
		noProgressFrom: 5,
		stopRequested: false,
		seats: ["/s"],
		scope: normal([WFC]),
	};
	const held = {
		...control,
		paused: { by: QUIET_BENCH_PAUSE, at: 6, why: "the bench is due" },
	};
	const set = (from: Parameters<typeof planSet>[0]["control"], ask: object) =>
		planSet({ control: from, damaged: null }, ask, {
			running: true,
			now: 7,
		}) as { write: Record<string, unknown> | null; lines: string[] };

	it("turns the route off and on", () => {
		const off = set(control, { quietBench: false });
		expect(off.write).toMatchObject({ quietBenchOff: true });
		const on = set({ ...control, quietBenchOff: true }, { quietBench: true });
		expect(on.write).not.toHaveProperty("quietBenchOff");
	});

	it("a founder's pause over the hold makes it his", () => {
		expect(set(held, { pause: true }).write?.paused).toEqual({
			by: "founder",
			at: 7,
		});
	});

	it("his resume ends the hold at once", () => {
		expect(set(held, { pause: false }).write).not.toHaveProperty("paused");
	});

	it("the pause text says why, and that the bench's end lifts it", () => {
		expect(buildPausedWaitText(held.paused)).toContain("the bench is due");
		expect(buildPausedWaitText(held.paused)).toContain("the bench ends");
	});
});

describe("planStart (#3868)", () => {
	const root = "/h/core";
	const stored = {
		noProgressFrom: 5,
		stopRequested: false,
		seats: ["/seat"],
		scope: { mode: "away" as const, repos: ["/h/manta"], goal: null },
	};
	const context = {
		pid: null as number | null,
		now: 100,
		root,
		seats: ["/file-seat"],
		seatErrors: [] as string[],
		stopped: null as { at: number; reason: string; detail: string } | null,
		unlessStopped: true,
	};
	const sound = (control: object | null = stored) =>
		({ control, damaged: null }) as Parameters<typeof planStart>[0];
	const plan = (
		read: Parameters<typeof planStart>[0],
		over: Partial<typeof context> = {},
	) => planStart(read, {}, { ...context, ...over });
	const selfStop = { at: 6, reason: "control-damaged", detail: "garbled" };
	const explicit = { at: 6, reason: "explicit", detail: "asked" };

	it.each([
		["a crash", {}, stored],
		["a stop the loop recorded for itself", { stopped: selfStop }, stored],
	])(
		"under unlessStopped starts as it was after %s, writing nothing",
		(_n, over, c) => {
			expect(plan(sound(c), over)).toEqual({
				write: null,
				control: stored,
				action: "start",
				lines: [],
			});
		},
	);

	it("under unlessStopped leaves an explicit stop, however it is recorded", () => {
		for (const [control, over] of [
			[stored, { stopped: explicit }],
			[{ ...stored, stopRequested: true, stopRequestedAt: 6 }, {}],
			[{ ...stored, stopRequested: true }, { stopped: selfStop }],
		] as const) {
			expect(plan(sound(control), over)).toMatchObject({
				write: null,
				action: "stopped",
				lines: [expect.stringContaining(": left stopped;")],
			});
		}
	});

	it("starts a first loop on a fresh control, this checkout ticked", () => {
		expect(plan(sound(null))).toMatchObject({
			action: "start",
			write: {
				seats: ["/file-seat"],
				scope: { mode: "normal", repos: [root], goal: null },
			},
		});
	});

	it("takes the seat file's seats only where a plain start ends a stop with no process", () => {
		const plain = { unlessStopped: false };
		expect(plan(sound(), plain)).toMatchObject({
			action: "start",
			write: { seats: ["/file-seat"], noProgressFrom: 100 },
		});
		expect(plan(sound(), { ...plain, pid: 9 })).toEqual({
			write: null,
			control: stored,
			action: "running",
			lines: ["refill loop running: pid 9"],
		});
	});

	it("refuses a seat file only where it would write seats", () => {
		const seatErrors = ["refill-seats:2: missing cycle-day="];
		for (const [read, over] of [
			[sound(), { pid: 9, unlessStopped: false }],
			[sound(), {}],
		] as const) {
			expect(plan(read, { ...over, seatErrors })).not.toHaveProperty("refused");
		}
		for (const [read, over] of [
			[sound(null), {}],
			[sound(), { unlessStopped: false }],
		] as const) {
			expect(plan(read, { ...over, seatErrors })).toEqual({
				refused: {
					reason: `the seat file refuses\n  ${seatErrors[0]}`,
					remedy: null,
					box: null,
				},
				exitCode: 2,
			});
		}
	});

	it("names a damaged control a plain start replaces, and refuses it under unlessStopped", () => {
		const read = { control: null, damaged: "control is damaged: x" };
		expect(plan(read, { unlessStopped: false })).toMatchObject({
			action: "start",
			lines: ["control is damaged: x; fresh settings written"],
		});
		expect(plan(read)).toEqual({
			refused: {
				reason: "control is damaged: x",
				remedy: "`start` rewrites it",
				box: null,
			},
			exitCode: 1,
		});
	});
});

describe("buildSetPlanJson (#3968)", () => {
	const warning = { reason: "not running", remedy: "later", box: null };
	const plan = {
		write: null,
		startFrom: null,
		lines: ["paused:    no"],
		warning,
	};

	it("adds what a start said to what the write said", () => {
		expect(
			buildSetPlanJson(plan, { lines: ["refill loop started: pid 7"] }),
		).toEqual({
			refused: null,
			warning,
			lines: ["paused:    no", "refill loop started: pid 7"],
		});
	});

	it("calls a process that would not start a warning, the write having landed", () => {
		expect(buildSetPlanJson(plan, { error: "no ref" })).toEqual({
			refused: null,
			warning: {
				reason: "not started: no ref",
				remedy: "run `start` once it is fixed",
				box: null,
			},
			lines: ["paused:    no"],
		});
	});
});
