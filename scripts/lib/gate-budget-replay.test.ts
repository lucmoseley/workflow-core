// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
	readWallClockRunS,
	renderReplay,
	renderSweep,
	replayPark,
} from "./gate-budget-replay.js";
import { BUDGET_RULE } from "./refill-budget.js";

type GateRun = import("./gate-seat.js").GateRun;
type ParkInput = import("./gate-budget-replay.js").ParkInput;

const T0 = Date.parse("2026-11-21T01:00:00.000Z");
const MIN = 60_000;
const SUITE = "bash test/all.sh";

const run = (
	minute: number,
	outcome: GateRun["outcome"],
	over: Partial<GateRun> = {},
): GateRun => ({
	at: new Date(T0 + minute * MIN).toISOString(),
	repo: "design-vault",
	tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
	command: SUITE,
	session: "s-parked",
	ticket: 473,
	waitS: 0,
	runS: 200,
	outcome,
	peakTreeMb: 3300,
	...over,
});

const input = (
	repoRuns: GateRun[],
	over: Partial<ParkInput> = {},
): ParkInput => ({
	park: {
		at: new Date(T0 + 60 * MIN).toISOString(),
		repo: "/home/u/design-vault",
		session: "s-parked",
		ticket: 473,
	},
	repoRuns,
	suiteCommand: SUITE,
	landings: [],
	...over,
});

describe("the budget park replay (#5471)", () => {
	it("keeps a park the rule makes, at the run it trips on", () => {
		const reds = [1, 2, 3, 4, 5].map((m) => run(m, "red"));
		expect(replayPark(input([run(0, "pass"), ...reds])).firstPark).toEqual({
			at: reds[3]?.at,
			why: "its 4 failed whole-suite gate runs in a row since its last landing, at the limit of 4",
			onBackstopPass: false,
		});
	});

	it("releases one whose failures were one-file runs and scripts through the gate, never counted", () => {
		const r = replayPark(
			input([
				run(1, "ceiling"),
				run(2, "ceiling"),
				run(3, "red", { command: "sh .claude/tmp/s-nest.sh" }),
				run(4, "red", { command: `${SUITE} test/a.test.sh` }),
				run(5, "red", { command: "sh .claude/tmp/s-nest2.sh" }),
			]),
		);
		expect(r.firstPark).toBeNull();
		expect(r.count).toMatchObject({ failStreak: 2, counted: 2 });
	});

	it("ignores runs after the park, and any other session's", () => {
		const late = [61, 62, 63, 64].map((m) => run(m, "red"));
		const other = [1, 2, 3, 4].map((m) =>
			run(m, "red", { session: "s-other" }),
		);
		expect(replayPark(input([...late, ...other])).firstPark).toBeNull();
	});

	it("takes a landing from when origin/main showed it, and counts the run ending in its commit's second before it", () => {
		const ct = Math.floor((T0 + 4 * MIN) / 1000) * 1000;
		const letThrough = {
			...run(0, "red"),
			at: new Date(ct + 287).toISOString(),
		};
		const runs = [
			run(1, "red"),
			run(2, "red"),
			run(3, "red"),
			letThrough,
			run(10, "red"),
			run(11, "red"),
			run(12, "red"),
		];
		expect(
			replayPark(input(runs, { landings: [{ arrivedAt: ct, at: ct }] }))
				.firstPark,
		).toBeNull();
		expect(
			replayPark(
				input(runs, { landings: [{ arrivedAt: ct + 5 * MIN, at: ct }] }),
			).firstPark?.at,
		).toBe(letThrough.at);
	});

	it("reads a line written on the wall clock before #5446 whose run outlasted the ceiling as a sleep, and leaves a line with wallS as written", () => {
		const slept = run(2, "ceiling", { runS: 31_544 });
		expect(readWallClockRunS(slept, BUDGET_RULE)).toMatchObject({
			wallS: 31_544,
			runS: 840,
		});
		const measured = run(2, "ceiling", { runS: 31_544, wallS: 31_544 });
		expect(readWallClockRunS(measured, BUDGET_RULE)).toBe(measured);
		expect(
			readWallClockRunS(run(2, "ceiling", { runS: 900 }), BUDGET_RULE).wallS,
		).toBe(undefined);
		const runs = [run(1, "ceiling"), slept, run(3, "red"), run(4, "red")];
		expect(replayPark(input(runs)).firstPark).toBeNull();
	});

	it("renders each park and the tally, and the sweep's kept parks per streak and backstop", () => {
		const thrash = input([1, 2, 3, 4].map((m) => run(m, "red")));
		const passing = input(
			[1, 2, 3, 4, 5, 6].map((m) =>
				run(m, "pass", { session: "s-green", ticket: 9 }),
			),
			{
				park: {
					at: new Date(T0 + 60 * MIN).toISOString(),
					repo: "/home/u/mantahostels",
					session: "s-green",
					ticket: 9,
				},
			},
		);
		const text = renderReplay([thrash, passing]);
		expect(text).toContain("design-vault #473 s-parked, parked");
		expect(text).toContain(
			"mantahostels #9 s-green, parked 2026-11-21T02:00:00.000Z: released, 0 failed in a row and 6 counted at its last run",
		);
		expect(text).toMatch(/Kept 1, released 1, of 2 parks\.$/);
		expect(
			renderSweep([thrash, passing], {
				streaks: [4, 5],
				backstops: [6, 10],
			}).split("\n"),
		).toEqual([
			"streak backstop kept",
			"4 6 2: design-vault #473 s-parked, mantahostels #9 s-green",
			"4 10 1: design-vault #473 s-parked",
			"5 6 1: mantahostels #9 s-green",
			"5 10 0: none",
		]);
	});

	it("names a park the backstop makes on a newest pass, its holds unjudged", () => {
		const passes = Array.from({ length: 10 }, (_, i) => run(i + 1, "pass"));
		expect(replayPark(input(passes)).firstPark).toMatchObject({
			at: passes[9]?.at,
			onBackstopPass: true,
		});
		expect(renderReplay([input(passes)])).toContain(
			"the #5438 and #5441 holds unjudged",
		);
	});
});
