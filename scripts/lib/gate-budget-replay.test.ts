// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
	firstHeldAt,
	renderReplay,
	renderSweep,
	unreadLine,
} from "./gate-budget-replay.js";

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

const replayed = (i: ParkInput) => renderReplay([i]).split("\n")[1];

const PARKED = "design-vault #473 s-parked, parked 2026-11-21T02:00:00.000Z:";

describe("the budget park replay (#5471)", () => {
	it("keeps a park the rule makes, at the run it trips on", () => {
		const reds = [1, 2, 3, 4, 5].map((m) => run(m, "red"));
		expect(replayed(input([run(0, "pass"), ...reds]))).toBe(
			`${PARKED} kept at ${reds[3]?.at}, on its 4 failed whole-suite gate runs in a row since its last landing, at the limit of 4`,
		);
	});

	it("releases one whose failures were one-file runs and scripts through the gate, never counted", () => {
		expect(
			replayed(
				input([
					run(1, "ceiling"),
					run(2, "ceiling"),
					run(3, "red", { command: "sh .claude/tmp/s-nest.sh" }),
					run(4, "red", { command: `${SUITE} test/a.test.sh` }),
					run(5, "red", { command: "sh .claude/tmp/s-nest2.sh" }),
				]),
			),
		).toBe(
			`${PARKED} released, 2 failed in a row and 2 counted at its last run`,
		);
	});

	it("ignores runs after the park, and any other session's", () => {
		const late = [61, 62, 63, 64].map((m) => run(m, "red"));
		const other = [1, 2, 3, 4].map((m) =>
			run(m, "red", { session: "s-other" }),
		);
		expect(replayed(input([...late, ...other]))).toBe(
			`${PARKED} released, no gate run of its read`,
		);
	});

	it("judges a resumed launch whole, from its start: its earlier session's runs its own, their ceilings never another's (#5514)", () => {
		const launch = {
			sessions: ["s-earlier", "s-parked"],
			launchedAt: new Date(T0 + 0.5 * MIN).toISOString(),
		};
		const earlier = { session: "s-earlier" };
		const runs = [
			run(0, "red", earlier),
			run(1, "ceiling", earlier),
			run(2, "ceiling", { session: "s-other" }),
			run(3, "red"),
			run(4, "ceiling"),
			run(5, "red"),
		];
		const asOne = input(runs);
		expect(replayed(asOne)).toContain(
			"released, 2 failed in a row and 2 counted",
		);
		const whole = input(runs, { park: { ...asOne.park, ...launch } });
		expect(replayed(whole)).toBe(
			`${PARKED} kept at ${runs[5]?.at}, on its 4 failed whole-suite gate runs in a row since its last landing, at the limit of 4`,
		);
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
			replayed(input(runs, { landings: [{ arrivedAt: ct, at: ct }] })),
		).toContain("released, 3 failed in a row and 3 counted");
		expect(
			replayed(
				input(runs, { landings: [{ arrivedAt: ct + 5 * MIN, at: ct }] }),
			),
		).toContain(`kept at ${letThrough.at}`);
	});

	it("skips a line written on the wall clock before #5446 whose run outlasted the ceiling, as a sleep, and reads a line with wallS as written", () => {
		const around = (slept: GateRun) =>
			replayed(input([run(1, "ceiling"), slept, run(3, "red"), run(4, "red")]));
		expect(around(run(2, "ceiling", { runS: 31_544 }))).toContain(
			"released, 3 failed in a row",
		);
		expect(
			around(run(2, "ceiling", { runS: 31_544, wallS: 31_544 })),
		).toContain("kept at");
		expect(around(run(2, "ceiling", { runS: 900 }))).toContain("kept at");
	});

	it("finds when origin/main first held a commit, by its reflog, and none where it never did", () => {
		const reflog = [10, 20, 30, 40].map((at) => ({ at, sha: `s${at}` }));
		const heldFrom = (first: number) => (sha: string) =>
			Number(sha.slice(1)) >= first;
		expect(firstHeldAt(reflog, heldFrom(30))).toBe(30);
		expect(firstHeldAt(reflog, heldFrom(0))).toBe(10);
		expect(firstHeldAt(reflog, heldFrom(99))).toBeNull();
		expect(firstHeldAt([], heldFrom(0))).toBeNull();
	});

	it("names what would not read for a park", () => {
		const { park } = input([]);
		expect(unreadLine(park, "commands.test")).toBe(
			"design-vault #473 s-parked: not replayed, its checkout's commands.test will not read",
		);
		expect(unreadLine(park, "commit ledger")).toBe(
			"design-vault #473 s-parked: its commit ledger will not read, so nothing of it is taken to have landed",
		);
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
		expect(replayed(input(passes))).toBe(
			`${PARKED} kept at ${passes[9]?.at}, on its 10 whole-suite gate runs since its last landing, at the backstop of 10 (a newest pass: the #5438 and #5441 holds unjudged)`,
		);
	});
});
