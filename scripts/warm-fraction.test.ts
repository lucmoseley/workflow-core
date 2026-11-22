// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const { LOG_SUBPATH, MIN_RUNS } = require("./lib/warm-fraction-log.js");

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "warm-fraction-cli-"));
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const rec = (at: string, session: string, warm: number[], cold: number[]) => ({
	at,
	frontier: warm.length + cold.length,
	warm: warm.length,
	cold: cold.length,
	causes: { never: cold.length, "body-changed": 0, "path-gone": 0, unknown: 0 },
	warmNumbers: warm,
	coldNumbers: cold.map((n) => ({ n, state: "never" })),
	session,
});

const write = (records: (object | string)[]) => {
	fs.mkdirSync(path.join(root, path.dirname(LOG_SUBPATH)), { recursive: true });
	fs.writeFileSync(
		path.join(root, LOG_SUBPATH),
		`${records
			.map((r) => (typeof r === "string" ? r : JSON.stringify(r)))
			.join("\n")}\n`,
	);
};

const runReport = (...args: string[]) => {
	const r = runInProcess(path.join(__dirname, "warm-fraction.js"), args, {
		env: { ...process.env, WFC_REPO_ROOT: root },
	});
	return { status: r.status, out: r.stdout, err: r.stderr };
};

const report = (...args: string[]) => {
	const r = runReport(...args);
	if (r.status !== 0)
		throw new Error(`warm-fraction.js exited ${r.status}: ${r.err}`);
	return r.out;
};

const line = (
	i: number,
	{ frontier, warm }: { frontier: number; warm: number },
	rest: Record<string, unknown> = {},
) => ({
	...rec(
		new Date(Date.parse("2026-08-01T00:00:00Z") + i * 3_600_000).toISOString(),
		"s",
		Array.from({ length: warm }, (_, k) => i * 1000 + k),
		Array.from({ length: frontier - warm }, (_, k) => i * 1000 + warm + k),
	),
	unrevalidatedWarm: 0,
	degraded: 0,
	putsSinceLastRun: 0,
	...rest,
});

const runs = (n: number, frontier: number, warm: number) =>
	Array.from({ length: n }, (_, i) => line(i, { frontier, warm }));

const spread = (
	n: number,
	a: { frontier: number; warm: number },
	b: { frontier: number; warm: number },
) => Array.from({ length: n }, (_, i) => line(i, i % 2 ? b : a));

describe("reporting the collapsed duplicates", () => {
	const dupPair = [
		rec("2026-08-19T08:14:08.000Z", "s1", [1, 2], [3, 4]),
		rec("2026-08-19T08:14:50.000Z", "s1", [1, 2], [3, 4]),
	];

	it("says how many lines were collapsed, so the exclusion is not silent", () => {
		write(dupPair);
		const out = report();
		expect(out).toMatch(/1 duplicate line\(s\) collapsed/);
		expect(out).toContain("1 real re-pick(s) recorded");
	});

	it("says nothing about duplicates where there were none", () => {
		write([dupPair[0]]);
		expect(report()).not.toContain("duplicate line(s) collapsed");
	});

	it("carries the counts into --json for a caller that reads the figures", () => {
		write(dupPair);
		const out = JSON.parse(report("--json"));
		expect(out.summary).toMatchObject({
			totalRuns: 2,
			usableRuns: 1,
			collapsedRuns: 1,
			collapsedSameSession: 1,
			collapsedCrossSession: 0,
		});
	});

	it("keeps a line something was put before, and says a band read ran in the gap", () => {
		write([dupPair[0], { ...dupPair[1], putsSinceLastRun: 2 }]);
		const out = report();
		expect(out).toMatch(/1 line\(s\) inside that window were kept/);
		expect(out).not.toContain("duplicate line(s) collapsed");
	});

	it("says which collapses rested on nothing having been put", () => {
		write(dupPair.map((r) => ({ ...r, putsSinceLastRun: 0 })));
		expect(report()).toMatch(
			/1 of these rested on a count of zero \(itself a floor/,
		);
	});

	it("carries the put-count figures into --json too", () => {
		write([dupPair[0], { ...dupPair[1], putsSinceLastRun: 2 }]);
		expect(JSON.parse(report("--json")).summary).toMatchObject({
			usableRuns: 2,
			collapsedRuns: 0,
			collapsedQuiet: 0,
			collapsedPutsUnknown: 0,
			runsKeptOnPuts: 1,
			runsKeptOnPutsCrossSession: 0,
		});
	});

	it("marks which line was dropped under --runs, so the collapse is auditable", () => {
		write(dupPair);
		const lines = report("--runs")
			.split("\n")
			.filter((l) => l.includes("frontier"));
		expect(lines.filter((l) => l.trim().startsWith("*"))).toHaveLength(1);
	});
});

describe("reporting a run that carried no fraction", () => {
	const runRows = (out: string) =>
		out.slice(out.indexOf("RUNS (oldest first)")).split("\n").slice(1);

	const empty = rec("2026-08-19T09:00:00.000Z", "s1", [], []);
	const real = rec("2026-08-19T09:30:00.000Z", "s1", [1, 2], [3]);

	it("marks it apart from a duplicate under --runs, not as counted", () => {
		write([empty, real]);
		const lines = runRows(report("--runs"));
		expect(lines[0].trim().startsWith("·")).toBe(true);
		expect(lines[1].trim().startsWith("·")).toBe(false);
		expect(lines[1].trim().startsWith("*")).toBe(false);
	});

	it("says why it was excluded, so the gap is not left to be inferred", () => {
		write([empty, real]);
		expect(report("--runs")).toContain("nothing takeable");
	});

	it("separates counted from duplicate in --json --runs", () => {
		write([empty, real]);
		const out = JSON.parse(report("--json", "--runs"));
		expect(
			out.runs.map((r: { duplicate: boolean; counted: boolean }) => [
				r.duplicate,
				r.counted,
			]),
		).toEqual([
			[false, false],
			[false, true],
		]);
	});
});

describe("with nothing recorded", () => {
	it("says so and exits 0, rather than reporting a fraction of nothing", () => {
		const r = runReport();
		expect(r.status).toBe(0);
		expect(r.out).toContain("Nothing recorded yet");
		expect(r.out).toContain(LOG_SUBPATH);
		expect(r.out).not.toContain("pooled");
	});

	it("exits 0 where the log cannot be read at all", () => {
		fs.mkdirSync(path.join(root, LOG_SUBPATH), { recursive: true });
		const r = runReport();
		expect(r.status).toBe(0);
		expect(r.out).toContain("Nothing recorded yet");
	});

	it("still answers --json, with no verdict", () => {
		const out = JSON.parse(report("--json"));
		expect(out.summary.usableRuns).toBe(0);
		expect(out.verdict.state).toBe("provisional");
	});
});

describe("the verdict", () => {
	it("refuses one under the ten-run floor, naming the shortfall", () => {
		write(runs(9, 10, 7));
		const out = report();
		expect(out).toContain(`PROVISIONAL — 9 of ${MIN_RUNS} runs`);
		expect(out).not.toContain("CONFIRMED");
		expect(out).not.toContain("REFUTED");
		expect(JSON.parse(report("--json")).verdict.state).toBe("provisional");
	});

	it("confirms a fraction whose whole band sits inside mantahostels#385's 60-80%", () => {
		write(spread(10, { frontier: 20, warm: 13 }, { frontier: 20, warm: 15 }));
		const out = report();
		expect(out).toContain("CONFIRMED — measured 70.0%");
		expect(out).toContain("Take this to mantahostels#789 as its answer.");
		expect(JSON.parse(report("--json")).verdict).toMatchObject({
			state: "confirmed",
			side: null,
			point: 0.7,
		});
	});

	it("refutes a fraction below the claim, and says plainly what that costs", () => {
		write(spread(10, { frontier: 10, warm: 1 }, { frontier: 10, warm: 3 }));
		const out = report();
		expect(out).toContain("REFUTED — measured 20.0%");
		expect(out).toContain("PLAINLY: the cache is warm on 20.0%");
		expect(JSON.parse(report("--json")).verdict.side).toBe("below");
	});

	it("refutes a fraction above the claim without the upkeep warning", () => {
		write(spread(10, { frontier: 20, warm: 19 }, { frontier: 20, warm: 18 }));
		const out = report();
		expect(out).toContain("REFUTED — measured 92.5%");
		expect(out).not.toContain("PLAINLY");
		expect(JSON.parse(report("--json")).verdict.side).toBe("above");
	});

	it("calls a band straddling the claim's edge inconclusive, not refuted", () => {
		write(spread(10, { frontier: 10, warm: 3 }, { frontier: 10, warm: 10 }));
		expect(report()).toContain("INCONCLUSIVE — measured 65.0%");
		expect(JSON.parse(report("--json")).verdict.side).toBeNull();
	});
});

describe("the interval the verdict is judged on", () => {
	it("does not confirm a band whose lower edge falls below the claim", () => {
		write(spread(10, { frontier: 20, warm: 11 }, { frontier: 20, warm: 15 }));
		expect(report()).toContain("INCONCLUSIVE — measured 65.0%");
	});

	it("does not confirm a band whose upper edge rises above the claim", () => {
		write(spread(10, { frontier: 20, warm: 14 }, { frontier: 20, warm: 18 }));
		expect(report()).toContain("INCONCLUSIVE — measured 80.0%");
	});

	it("reports the band alongside the figure, not the figure alone", () => {
		write(spread(10, { frontier: 20, warm: 13 }, { frontier: 20, warm: 15 }));
		expect(report()).toMatch(/per-run mean {2}70\.0% ± \d+\.\d points \(95%\)/);
	});
});

describe("what the report qualifies", () => {
	it("pools over the tickets, not over the runs", () => {
		write([
			line(0, { frontier: 100, warm: 50 }),
			line(1, { frontier: 2, warm: 2 }),
		]);
		expect(report()).toContain("pooled        51.0%  (52 warm of 102");
	});

	it("shows no cause share where nothing was cold", () => {
		write([line(0, { frontier: 10, warm: 10 })]);
		expect(report()).toContain("never derived  0 (—)");
	});

	it("labels the header as entries over distinct tickets, not as tickets alone (mantahostels#1428)", () => {
		write([
			line(0, { frontier: 10, warm: 8 }, { session: "s1" }),
			{
				...line(0, { frontier: 10, warm: 8 }, { session: "s2" }),
				coldNumbers: [
					{ n: 9, state: "never" },
					{ n: 1001, state: "never" },
				],
			},
		]);
		expect(report()).toContain(
			"WHY THE COLD ONES WERE COLD (4 cold entries over 3 distinct ticket(s))",
		);
	});

	it("says when a collapse could not be attributed to any session", () => {
		const first = line(0, { frontier: 10, warm: 5 }, { session: null });
		write([
			first,
			{ ...first, at: new Date(Date.parse(first.at) + 60_000).toISOString() },
		]);
		expect(report()).toContain("naming no session, so unattributable");
	});

	it("flags a degraded run, whose fraction is over a smaller frontier", () => {
		write([line(0, { frontier: 10, warm: 5 }, { degraded: 1 })]);
		expect(report()).toContain("1 of these runs was degraded");
	});

	it("flags warm hits that never got the rename check", () => {
		write([line(0, { frontier: 10, warm: 5 }, { unrevalidatedWarm: 2 })]);
		expect(report()).toContain("2 warm hit(s) skipped the rename check");
	});

	it("counts a line it could not read rather than dropping it silently", () => {
		write([line(0, { frontier: 10, warm: 5 }), "{not json", '{"at":"x"}']);
		expect(report()).toContain("2 unreadable line(s) skipped");
	});

	it("marks each line's duplicate status in --json --runs", () => {
		const first = line(0, { frontier: 10, warm: 5 });
		write([
			first,
			{ ...first, at: new Date(Date.parse(first.at) + 300_000).toISOString() },
		]);
		const out = JSON.parse(report("--json", "--runs"));
		expect(out.runs.map((r: { duplicate: boolean }) => r.duplicate)).toEqual([
			false,
			true,
		]);
	});
});

describe("the covered fraction's own floor (mantahostels#1054)", () => {
	const prewarmed = (n: number) =>
		Array.from({ length: n }, (_, i) => ({
			...line(i, { frontier: 4, warm: 2 }),
			provisional: 2,
			provisionalNumbers: [i * 1000 + 900, i * 1000 + 901],
		}));

	it("withholds the figure under ten runs carrying a provisional count", () => {
		write(prewarmed(4));
		const out = report();
		expect(out).toContain("covered       WITHHELD — 4 of 10");
		expect(out).toContain("The arithmetic would give");
	});

	it("states it once ten such runs exist", () => {
		write(prewarmed(10));
		const out = report();
		expect(out).not.toContain("WITHHELD");
		expect(out).toMatch(/covered {2,}\d+\.\d%/);
	});

	it("says nothing about covered where no run pre-warmed anything", () => {
		write(runs(10, 4, 2));
		expect(report()).not.toContain("covered");
	});

	it("carries the floor and its state into --json", () => {
		write(prewarmed(4));
		const j = JSON.parse(report("--json"));
		expect(j.coveredVerdict).toMatchObject({ state: "provisional", runs: 4 });
		expect(j.minProvisionalRuns).toBe(10);
	});
});

describe("the two sides of the pre-warming change (mantahostels#1054)", () => {
	it("says there is nothing to split while no line carries the field", () => {
		write(runs(4, 4, 2));
		expect(report()).toContain("nothing to split");
	});

	it("summarises each side apart, naming the split point", () => {
		write([
			...runs(2, 4, 2),
			{
				...line(2, { frontier: 4, warm: 1 }),
				provisional: 2,
				provisionalNumbers: [2901, 2902],
			},
		]);
		const out = report();
		expect(out).toContain("BEFORE AND AFTER PRE-WARMING (mantahostels#1054)");
		expect(out).toContain("split at 2026-08-01T02:00:00.000Z");
		expect(out).toMatch(/before {2}pooled 50\.0%/);
		expect(out).toMatch(/after {3}pooled 25\.0%/);
	});

	it("carries coldDistinctTickets into --json on both sides of the split (mantahostels#1428)", () => {
		const t = (i: number) =>
			new Date(
				Date.parse("2026-08-01T00:00:00Z") + i * 3_600_000,
			).toISOString();
		write([
			...runs(2, 4, 2),
			{
				...rec(t(2), "s", [50], [2001, 2002, 2003]),
				provisional: 2,
				provisionalNumbers: [2901, 2902],
				unrevalidatedWarm: 0,
				degraded: 0,
				putsSinceLastRun: 0,
			},
			{
				...rec(t(3), "s2", [60], [2001]),
				provisional: 2,
				provisionalNumbers: [2901, 2902],
				unrevalidatedWarm: 0,
				degraded: 0,
				putsSinceLastRun: 0,
			},
		]);
		const out = JSON.parse(report("--json"));
		expect(out.split.after.coldTotal).toBe(4);
		expect(out.split.after.coldDistinctTickets).toBe(3);
	});

	it("places a run whose instant cannot be read on neither side, and says so", () => {
		write([
			...runs(2, 4, 2),
			{
				...line(2, { frontier: 4, warm: 1 }),
				at: "not-a-date",
				provisional: 2,
				provisionalNumbers: [2901, 2902],
			},
		]);
		const out = report();
		expect(out).toContain("1 run(s) carry an unreadable instant");
		expect(out).toContain("nothing to split");
	});
});

describe("the verdict when the log spans the pre-warming split (mantahostels#1327)", () => {
	const afterFixture = (n: number, warm: number, provisional: number) =>
		Array.from({ length: n }, (_, k) => ({
			...line(2 + k, { frontier: 4, warm }),
			provisional,
			provisionalNumbers: Array.from(
				{ length: provisional },
				(_slot, p) => (2 + k) * 1000 + 900 + p,
			),
		}));

	it("refuses a pooled verdict once the log spans the split, and points to mantahostels#789", () => {
		write([...runs(2, 4, 2), ...afterFixture(1, 1, 2)]);
		const out = report();
		expect(out).toContain(
			"UNINTERPRETABLE — `pooled` above averages before and after pre-warming",
		);
		expect(out).not.toContain("CONFIRMED");
		expect(out).not.toContain("REFUTED —");
		expect(out).toContain("Take this to mantahostels#789 as its answer.");
	});

	it("withholds the covered bound under ten post-split provisional runs", () => {
		write([...runs(2, 4, 2), ...afterFixture(1, 1, 2)]);
		expect(report()).toContain("COVERED BOUND — PROVISIONAL, 1 of 10");
	});

	it("says the bound rules nothing out where covered stays high", () => {
		write([...runs(2, 4, 2), ...afterFixture(10, 1, 2)]);
		const out = report();
		expect(out).toContain(
			"COVERED BOUND — 75.0% (95% band 75.0% – 75.0%).\n  An upper bound this high rules nothing out",
		);
		expect(JSON.parse(report("--json")).boundVerdict).toMatchObject({
			state: "inconclusive",
			point: 0.75,
		});
	});

	it("refutes the claim outright where even the bound falls below it", () => {
		write([...runs(2, 4, 2), ...afterFixture(10, 0, 1)]);
		const out = report();
		expect(out).toContain(
			"COVERED BOUND — 25.0% (95% band 25.0% – 25.0%),\n  the whole band below 60.0%: the bound itself rules out",
		);
		expect(JSON.parse(report("--json")).boundVerdict).toMatchObject({
			state: "refuted",
			point: 0.25,
		});
	});

	it("does not refute a covered bound on noise, if the after side ever carries a spread", () => {
		write([
			...runs(2, 4, 2),
			...Array.from({ length: 10 }, (_, k) => ({
				...line(2 + k, { frontier: 4, warm: 0 }),
				provisional: k % 2 ? 3 : 1,
				provisionalNumbers: [(2 + k) * 1000 + 900],
			})),
		]);
		const out = report();
		expect(out).not.toContain("the bound itself rules out");
		expect(JSON.parse(report("--json")).boundVerdict.state).toBe(
			"inconclusive",
		);
	});

	it("carries a null after-split verdict in --json where there is nothing to split", () => {
		write(runs(2, 4, 2));
		const out = JSON.parse(report("--json"));
		expect(out.afterCoveredVerdict).toBeNull();
		expect(out.boundVerdict).toBeNull();
	});

	it("carries a headlineVerdict in --json that never reads the cross-split pooled figure", () => {
		write([...runs(2, 4, 2), ...afterFixture(10, 0, 1)]);
		const out = JSON.parse(report("--json"));
		expect(out.headlineVerdict).toMatchObject({
			basis: "covered-bound",
			uninterpretablePooled: true,
			state: "refuted",
			point: 0.25,
		});
		expect(out.verdict.point).not.toBeCloseTo(out.headlineVerdict.point);
	});

	it("falls back to the pooled verdict in --json headlineVerdict where there is nothing to split", () => {
		write(spread(10, { frontier: 20, warm: 13 }, { frontier: 20, warm: 15 }));
		const out = JSON.parse(report("--json"));
		expect(out.headlineVerdict).toMatchObject({
			basis: "pooled",
			state: "confirmed",
			point: 0.7,
		});
	});
});

describe("the window a figure was read over (mantahostels#789)", () => {
	it("prints the span beside the endpoints, not the endpoints alone", () => {
		write(runs(3, 4, 2));
		expect(report()).toContain("(2.0 hours)");
	});

	it("switches to days once the window passes two of them", () => {
		write(runs(73, 4, 2));
		expect(report()).toContain("(3.0 days)");
	});
});
