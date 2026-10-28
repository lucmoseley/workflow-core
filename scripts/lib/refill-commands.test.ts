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
import { buildStatusLines, mergedScope } from "./refill-commands.js";
import { parseState } from "./refill-loop.js";
import {
	away,
	DV,
	type Launch,
	MH,
	MIN,
	NOW,
	normal,
	record,
	WFC,
} from "./refill-loop-fixture";

describe("the scope a start writes", () => {
	it("starts a stopped loop on the scope asked for", () => {
		expect(mergedScope(null, normal([WFC]), WFC)).toEqual({
			scope: normal([WFC]),
			renew: true,
		});
	});

	it("adds a normal start's repos to a running normal loop's", () => {
		const r = mergedScope(
			normal([MH], { [MH]: [5] }),
			normal([WFC], { [WFC]: [9] }),
			WFC,
		);
		expect(r.renew).toBe(true);
		expect(r.scope).toEqual(normal([MH, WFC], { [MH]: [5], [WFC]: [9] }));
	});

	it("clears the starting repo's goal on a bare start, keeping others'", () => {
		const r = mergedScope(
			normal([WFC, MH], { [WFC]: [9], [MH]: [5] }),
			normal([WFC]),
			WFC,
		);
		expect(r.scope.goals).toEqual({ [MH]: [5] });
	});

	it("never narrows or renews a running away mode from a normal start", () => {
		const r = mergedScope(away([DV]), normal([WFC], { [WFC]: [9] }), WFC);
		expect(r.renew).toBe(false);
		expect(r.scope).toEqual(away([DV], { [WFC]: [9] }));
	});

	it("widens a running normal loop to away mode, keeping its goals", () => {
		const r = mergedScope(normal([WFC], { [WFC]: [9] }), away([DV]), MH);
		expect(r.renew).toBe(true);
		expect(r.scope).toEqual(away([DV], { [WFC]: [9] }));
	});
});

describe("what status prints", () => {
	const control = {
		startedAt: NOW - 60 * MIN,
		stopRequested: false,
		seats: ["/home/u/.claude3", "/home/u/.claude2"],
		scope: normal([WFC, MH], { [WFC]: [116, 117] }),
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
			reason: "no-progress",
			detail: "three in a row",
		},
		reviewRunOn: null,
	};
	const runMs = 24 * 60 * MIN;
	const served = [WFC, MH];

	it("gives start, stop time, launches since the start and the last stop", () => {
		const out = buildStatusLines({
			control,
			state,
			pid: 123,
			runMs,
			served,
		}).join("\n");
		expect(out).toContain("running, pid 123");
		expect(out).toContain(
			`started:   ${new Date(control.startedAt).toISOString()}`,
		);
		expect(out).toContain(
			`stops by:  ${new Date(control.startedAt + runMs).toISOString()}`,
		);
		expect(out).toContain("launches:  1 since start, 1 running, 0 parked");
		expect(out).toContain("/implement 1  running");
		expect(out).not.toContain("/implement 2");
		expect(out).toContain("/implement 42  finished");
		expect(out).not.toContain("session ");
		expect(out).toContain("idle: no free slot");
		expect(out).toContain("last stop:");
		expect(out).toContain("no-progress — three in a row");
	});
	it("counts a park the loop stopped as parked, and says it stopped it (#2699)", () => {
		const stopped = record({
			launchedAt: NOW - 20 * MIN,
			prompt: "/implement 9",
			finishedAt: NOW,
			parkStopped: NOW - MIN,
		});
		const out = buildStatusLines({
			control,
			state: { ...state, launches: [...state.launches, stopped] },
			pid: 123,
			runMs,
			served,
		}).join("\n");
		expect(out).toContain("launches:  2 since start, 1 running, 1 parked");
		expect(out).toContain("/implement 9  parked, stopped");
	});

	it("lists the last tick's skipped rows, ten and a count past them (#2561)", () => {
		const skipped = Array.from({ length: 12 }, (_, i) => ({
			root: WFC,
			number: 100 + i,
			why: i === 0 ? "parked" : "already running",
		}));
		const lines = buildStatusLines({
			control,
			state: {
				...state,
				lastTick: { at: NOW, summary: "idle: nothing launchable", skipped },
			},
			pid: 123,
			runMs,
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
			control,
			state: {
				...state,
				launches: [record({ launchedAt: NOW, sessionId: "sess-9" })],
			},
			pid: 123,
			runMs,
			served,
		}).join("\n");
		expect(out).toContain("/implement 42  running  session sess-9");
	});

	it("names the mode, the repos and the goal", () => {
		const out = buildStatusLines({
			control,
			state,
			pid: 123,
			runMs,
			served,
		}).join("\n");
		expect(out).toContain("mode:      normal");
		expect(out).toContain("repos:     workflow-core, mantahostels");
		expect(out).toContain("goal:      workflow-core #116, #117");
		const awayOut = buildStatusLines({
			control: { ...control, scope: away([DV]) },
			state,
			pid: 123,
			runMs,
			served,
		}).join("\n");
		expect(awayOut).toContain("mode:      away (every included repo)");
		expect(awayOut).toContain("repos:     workflow-core, mantahostels");
		expect(awayOut).toContain("excluding: design-vault");
		expect(awayOut).toContain("goal:      none");
	});

	it("says a requested stop is pending while the loop still runs", () => {
		const out = buildStatusLines({
			control: { ...control, stopRequested: true },
			state,
			pid: 123,
			runMs,
			served,
		}).join("\n");
		expect(out).toContain("at its next tick, on request");
	});

	it("says when the loop is not running or never started", () => {
		const out = buildStatusLines({
			control: null,
			state: { launches: [], lastTick: null, stopped: null, reviewRunOn: null },
			pid: null,
			runMs,
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
			control: {
				startedAt: NOW - 60 * MIN,
				stopRequested: false,
				seats: [],
				scope: normal([DV]),
			},
			state: { launches, lastTick: null, stopped: null, reviewRunOn: null },
			pid: 1,
			runMs: 60 * MIN,
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

	it("shows a launch stopped under the swap hold, and when (#3093)", () => {
		const swapHeld = { at: NOW - 6 * MIN, sessionId: "s", cwd: "/", tries: 0 };
		expect(statusOf([record({ swapHeld })])).toContain(
			"stopped under the swap hold since 2026-10-18T11:54:00.000Z, resumed once it clears",
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

describe("a handed-off launch (#2659)", () => {
	it("reads a handed-off launch's state for status", () => {
		const out = buildStatusLines({
			control: {
				startedAt: NOW - 60 * MIN,
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
				reviewRunOn: null,
			},
			pid: 1,
			runMs: 60 * MIN,
			served: [DV],
		}).join("\n");
		expect(out).toContain("handed off: stopped idle after its host's restart");
	});
});
