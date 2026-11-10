// @vitest-environment node
/*
 * The quiet bench route's decision (#3852). Loosen one and the fleet is paused
 * under a founder at the keyboard, a pause of his is overwritten or lifted, or a
 * dead runner leaves the fleet paused.
 */

import { describe, expect, it } from "vitest";
import {
	buildEnding,
	buildRowsReading,
	buildRunComment,
	countUsableRows,
	decideQuietBench,
	isLoneSuiteFit,
	isRunAnswering,
	LADDER_BENCH,
	LADDER_STAMP,
	parseBenchState,
	parseFree,
} from "./quiet-bench.js";
import { NO_PROGRESS_PAUSE, QUIET_BENCH_PAUSE } from "./refill-decide.js";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const OURS = { by: QUIET_BENCH_PAUSE, at: NOW - 1000 };
const QUIET = { sessions: 3, availableMb: LADDER_BENCH.startMb };
const IDLE = parseBenchState(null);

type Tick = Parameters<typeof decideQuietBench>[0];

const tick = (over: Partial<Tick> = {}): Tick => ({
	now: NOW,
	off: false,
	present: false,
	state: IDLE,
	readDue: () => true,
	readQuiet: () => QUIET,
	readRunner: () => ({ alive: false, ended: null }),
	...over,
});

const draining = (over = {}) => ({
	...IDLE,
	attemptAt: NOW - 1000,
	phase: "drain" as const,
	since: NOW - 1000,
	...over,
});

const running = {
	...IDLE,
	attemptAt: NOW - HOUR,
	phase: "run" as const,
	since: NOW - HOUR,
};

describe("taking the hold", () => {
	it("pauses launches on a due bench, the founder absent and no attempt in 24 h", () => {
		const step = decideQuietBench(tick());
		expect(step.hold).toBe("take");
		expect(step.state).toMatchObject({
			phase: "drain",
			attemptAt: NOW,
			since: NOW,
		});
	});

	it.each([
		["the founder present", { present: true }],
		["no measurement due", { readDue: () => false }],
		["the setting off", { off: true }],
		[
			"an attempt inside 24 h",
			{ state: { ...IDLE, attemptAt: NOW - DAY + 1 } },
		],
	])("takes no hold with %s", (_name, over) => {
		const step = decideQuietBench(tick(over));
		expect(step.hold).toBeUndefined();
		expect(step.state.phase).toBeNull();
	});

	it("tries again once 24 h have passed", () => {
		const state = { ...IDLE, attemptAt: NOW - DAY };
		expect(decideQuietBench(tick({ state })).hold).toBe("take");
	});

	it("reads due no oftener than once an hour", () => {
		let reads = 0;
		const readDue = () => {
			reads += 1;
			return false;
		};
		const first = decideQuietBench(tick({ readDue }));
		decideQuietBench(tick({ readDue, state: first.state, now: NOW + 1000 }));
		expect(reads).toBe(1);
		decideQuietBench(tick({ readDue, state: first.state, now: NOW + HOUR }));
		expect(reads).toBe(2);
	});
});

describe("another's pause", () => {
	it.each([
		["the founder's", { by: "founder", at: 1 }],
		["the no-progress rule's", { by: NO_PROGRESS_PAUSE, at: 1 }],
	])("leaves %s neither overwritten nor lifted", (_name, paused) => {
		for (const state of [IDLE, draining(), running]) {
			const step = decideQuietBench(tick({ paused, state }));
			expect(step.hold).toBeUndefined();
			expect(step.start).toBeUndefined();
		}
	});

	it("ends a drain whose pause was resumed or replaced, the attempt counted", () => {
		const step = decideQuietBench(tick({ state: draining() }));
		expect(step.hold).toBeUndefined();
		expect(step.state).toMatchObject({ phase: null, attemptAt: NOW - 1000 });
	});
});

describe("starting", () => {
	const startAfter = (first: Tick["readQuiet"], second: Tick["readQuiet"]) => {
		const one = decideQuietBench(
			tick({ paused: OURS, state: draining(), readQuiet: first }),
		);
		const two = decideQuietBench(
			tick({
				paused: OURS,
				state: one.state,
				now: NOW + 5 * MINUTE,
				readQuiet: second,
			}),
		);
		return { one, two };
	};
	const quiet = () => QUIET;

	it("starts on two readings five minutes apart", () => {
		const { one, two } = startAfter(quiet, quiet);
		expect(one.start).toBeUndefined();
		expect(two.start).toBe(true);
		expect(two.hold).toBe("running");
		expect(two.state.phase).toBe("run");
	});

	it("starts on no single reading, however long the drain has run", () => {
		const step = decideQuietBench(
			tick({ paused: OURS, state: draining({ since: NOW - HOUR }) }),
		);
		expect(step.start).toBeUndefined();
	});

	it("does not start before five minutes", () => {
		const one = decideQuietBench(tick({ paused: OURS, state: draining() }));
		const two = decideQuietBench(
			tick({ paused: OURS, state: one.state, now: NOW + 5 * MINUTE - 1 }),
		);
		expect(two.start).toBeUndefined();
	});

	it.each([
		["sessions alone", { sessions: 0, availableMb: LADDER_BENCH.startMb - 1 }],
		["memory alone", { sessions: 4, availableMb: 9000 }],
		["an unread count", { sessions: null, availableMb: 9000 }],
		["an unread memory", { sessions: 0, availableMb: null }],
	])("does not start on %s", (_name, reading) => {
		expect(startAfter(quiet, () => reading).two.start).toBeUndefined();
		expect(startAfter(() => reading, quiet).two.start).toBeUndefined();
	});

	it("starts its five minutes over on a reading that breaks them", () => {
		const { two } = startAfter(quiet, () => ({ ...QUIET, sessions: 9 }));
		expect(two.state.quietSince).toBeNull();
	});

	it("starts its five minutes over after a gap between readings, as a stopped loop leaves", () => {
		const state = draining({
			quietSince: NOW - 2 * HOUR,
			quietAt: NOW - 2 * HOUR,
		});
		const step = decideQuietBench(tick({ paused: OURS, state }));
		expect(step.start).toBeUndefined();
		expect(step.state.quietSince).toBe(NOW);
	});
});

describe("every ending lifts the hold", () => {
	it.each([
		["finished", "finished"],
		["refused", "exit 1: refused: 9 sessions live"],
	])("lifts it on a run %s", (_name, ended) => {
		const step = decideQuietBench(
			tick({
				paused: OURS,
				state: running,
				readRunner: () => ({ alive: false, ended }),
			}),
		);
		expect(step.hold).toBe("lift");
		expect(step.state.phase).toBeNull();
		expect(step.line).toContain(ended);
	});

	it("lifts it on a runner dead with no result, whatever process reads it", () => {
		const restored = parseBenchState(JSON.parse(JSON.stringify(running)));
		const step = decideQuietBench(tick({ paused: OURS, state: restored }));
		expect(step.hold).toBe("lift");
		expect(step.line).toContain("died");
	});

	it("lifts it at the drain limit, the attempt counted", () => {
		const state = draining({ since: NOW - 4 * HOUR });
		const step = decideQuietBench(tick({ paused: OURS, state }));
		expect(step.hold).toBe("lift");
		expect(step.state).toMatchObject({ phase: null, attemptAt: NOW - 1000 });
	});

	it("lifts a pause with no run behind it, as a damaged state leaves", () => {
		const step = decideQuietBench(
			tick({ paused: OURS, state: parseBenchState("garbled") }),
		);
		expect(step.hold).toBe("lift");
	});

	it("lifts it and stops a runner still alive past the run limit", () => {
		const state = { ...running, since: NOW - 4 * HOUR };
		const alive = () => ({ alive: true, ended: null });
		const step = decideQuietBench(
			tick({ paused: OURS, state, readRunner: alive }),
		);
		expect(step).toMatchObject({ hold: "lift", stop: true });
		const founderResumed = decideQuietBench(tick({ state, readRunner: alive }));
		expect(founderResumed.stop).toBe(true);
		expect(founderResumed.hold).toBeUndefined();
	});

	it("holds while the runner lives", () => {
		const step = decideQuietBench(
			tick({
				paused: OURS,
				state: running,
				readRunner: () => ({ alive: true, ended: null }),
			}),
		);
		expect(step.hold).toBeUndefined();
		expect(step.stop).toBeUndefined();
		expect(step.state.phase).toBe("run");
	});

	it("waits out a runner just started, its pidfile yet to appear", () => {
		const state = { ...running, since: NOW - 1000 };
		const step = decideQuietBench(tick({ paused: OURS, state }));
		expect(step.hold).toBeUndefined();
	});
});

describe("the founder back, or the route off", () => {
	it.each([
		["the founder present", { present: true }],
		["the route off", { off: true }],
	])("lifts a drain and ends it with %s", (_name, over) => {
		const step = decideQuietBench(
			tick({ paused: OURS, state: draining(), ...over }),
		);
		expect(step.hold).toBe("lift");
		expect(step.state.phase).toBeNull();
		expect(step.start).toBeUndefined();
	});

	it.each([
		["the founder present", { present: true }],
		["the route off", { off: true }],
	])(
		"lifts a running bench's hold and leaves the bench with %s",
		(_name, over) => {
			const step = decideQuietBench(
				tick({
					paused: OURS,
					state: running,
					readRunner: () => ({ alive: true, ended: null }),
					...over,
				}),
			);
			expect(step.hold).toBe("lift");
			expect(step.stop).toBeUndefined();
			expect(step.state.phase).toBe("run");
		},
	);
});

describe("the lone whole suite the bench waits for (#4931)", () => {
	it("is due at 448 s on 8 cores, where 3 suites at 3 workers take 1.875 times a lone 5-worker suite, and not past it", () => {
		expect(isLoneSuiteFit({ durationMs: 448_000 }, 8)).toBe(true);
		expect(isLoneSuiteFit({ durationMs: 448_001 }, 8)).toBe(false);
	});

	it("is not due on a lone suite killed at the ceiling, or none", () => {
		expect(isLoneSuiteFit({ durationMs: 1000, ceilingKill: true }, 8)).toBe(
			false,
		);
		expect(isLoneSuiteFit(null, 8)).toBe(false);
	});
});

describe("the bench's command", () => {
	it("is the one #2862 named", () => {
		expect(LADDER_BENCH.args.join(" ")).toBe("1 2 3 1 2 3 --require-quiet=3");
	});
});

describe("the kept rows", () => {
	const usable = (suites: number) => ({
		suites,
		baseline_stationary: true,
		all_green: true,
		ceiling_killed: 0,
	});
	const whole = [1, 2, 3, 1, 2, 3].map(usable);
	const run = (rows: object[], ladder: string | null = LADDER_STAMP) => ({
		id: "a",
		dir: "/d",
		rows,
		ladder,
	});

	it("reads a run as answering on two usable rows per count", () => {
		expect(isRunAnswering(run(whole))).toBe(true);
		expect(isRunAnswering(run(whole.slice(0, 5)))).toBe(false);
	});

	it("reads a run of an earlier ladder as answering nothing, so a later drift is due", () => {
		expect(isRunAnswering(run(whole, "485 files, 16 Oct 2026 and gone"))).toBe(
			false,
		);
		expect(isRunAnswering(run(whole, null))).toBe(false);
		expect(buildRowsReading([run(whole, null)])).toBe(
			"no usable bench rows kept",
		);
	});

	it.each([
		["skipped not quiet", { suites: 3, skipped_not_quiet: true }],
		["skipped below the floor", { suites: 3, skipped_below_floor: true }],
		["aborted", { ...usable(3), aborted_by_watchdog: true }],
		["contaminated", { ...usable(3), baseline_stationary: false }],
		[
			"killed at the ceiling (#4031)",
			{ ...usable(3), all_green: false, ceiling_killed: 1 },
		],
	])("does not count a row %s", (_name, row) => {
		expect(countUsableRows([row]).get(3)).toBe(0);
	});

	it("counts a row whose suites only failed tests, which ran to their end (#4031)", () => {
		expect(countUsableRows([{ ...usable(3), all_green: false }]).get(3)).toBe(
			1,
		);
	});

	it("reads a run a row of which reached the ceiling as answering, so no rerun drains the fleet for it (#4031)", () => {
		const cut = [usable(1), { ...usable(2), ceiling_killed: 2 }];
		expect(isRunAnswering(run(cut))).toBe(true);
		expect(isRunAnswering(run(cut, null))).toBe(false);
		expect(buildRowsReading([run(cut)])).toBe(
			"a: usable rows per suite count 1:1 2:0 3:0, lower-bound rows 1:0 2:0 3:0, reached the suite ceiling",
		);
	});

	describe("a ceiling-killed row (#4606)", () => {
		/* The 3 Nov run's shape: lowest at 292-368 s of an 840 s wall. */
		const killed = (suites: number, lowestAt: number) => ({
			...usable(suites),
			all_green: false,
			ceiling_killed: suites,
			wall_s: 840,
			samples: [
				{ t: 1, avail_mb: 7900 },
				{ t: lowestAt, avail_mb: 6400 },
				{ t: 839, avail_mb: 6500 },
			],
		});

		it("counts as a lower-bound row, never a usable one, where its dip plateaued in the first half", () => {
			expect(buildRowsReading([run([killed(2, 300)])])).toContain(
				"lower-bound rows 1:0 2:1 3:0",
			);
			expect(countUsableRows([killed(2, 300)]).get(2)).toBe(0);
		});

		it("counts as neither where its lowest sample came in the second half", () => {
			expect(buildRowsReading([run([killed(2, 600)])])).toContain(
				"lower-bound rows 1:0 2:0 3:0",
			);
			expect(countUsableRows([killed(2, 600)]).get(2)).toBe(0);
		});

		it("counts as neither on a baseline that moved", () => {
			const moved = { ...killed(2, 300), baseline_stationary: false };
			expect(buildRowsReading([run([moved])])).toContain(
				"lower-bound rows 1:0 2:0 3:0",
			);
		});

		it("ends a run of two lower-bound or usable rows per count as a lower bound", () => {
			const bounded = [
				usable(1),
				...[1, 2, 3, 2, 3].map((n) => killed(n, 300)),
			];
			expect(isRunAnswering(run(bounded))).toBe(true);
			expect(buildRowsReading([run(bounded)])).toBe(
				"a: usable rows per suite count 1:1 2:0 3:0, lower-bound rows 1:1 2:2 3:2, lower bound",
			);
		});
	});

	it("names each run in the gate's reading, and none until a row is usable", () => {
		expect(
			buildRowsReading([run([{ suites: 1, skipped_not_quiet: true }])]),
		).toBe("no usable bench rows kept");
		expect(buildRowsReading([run(whole)])).toBe(
			"a: usable rows per suite count 1:2 2:2 3:2, lower-bound rows 1:0 2:0 3:0, complete",
		);
	});
});

describe("a run's comment", () => {
	it("carries the rows, how it ended, and free -m and load1 beside them", () => {
		const body = buildRunComment({
			id: "a",
			dir: "/d",
			ladder: LADDER_STAMP,
			ending: "finished",
			rows: [
				{ suites: 1, wall_s: 9 },
				{ suites: 2, skipped_not_quiet: true },
				{ suites: 3, skipped_below_floor: true },
				{ suites: 2, wall_s: 841, ceiling_killed: 1 },
			],
			machine: [
				{
					label: "before the bench",
					availableMb: "4000",
					totalMb: "9924",
					swapUsedMb: "5",
					load1: 1.5,
				},
			],
		});
		expect(body).toContain("finished");
		expect(body).toContain("| 1 | 1 | 9 s |");
		expect(body).toContain("skipped: not quiet");
		expect(body).toContain("skipped: below the floor");
		expect(body).toContain("| 4 | 2 | 841 s, 1 killed at the ceiling |");
		expect(body).toContain(
			"- before the bench: available 4000 MB of 9924, swap used 5 MB, load1 1.5",
		);
	});

	it("says so with no rows", () => {
		const body = buildRunComment({
			id: "a",
			dir: "/d",
			ladder: null,
			ending: "x",
			rows: [],
			machine: [],
		});
		expect(body).toContain("No rows.");
	});

	it.each([
		[0, null, "finished"],
		[1, null, "exit 1: why"],
		[null, "SIGTERM", "killed by SIGTERM"],
	])("reads an ending of %s, %s as %s", (status, signal, text) => {
		expect(buildEnding(status, signal, "why")).toBe(text);
	});

	it("reads free -m's columns", () => {
		expect(
			parseFree(
				"               total        used        free      shared  buff/cache   available\nMem:            9924        5000         100          10        4000        4004\nSwap:           2047         486        1561\n",
			),
		).toEqual({ availableMb: "4004", totalMb: "9924", swapUsedMb: "486" });
	});
});
