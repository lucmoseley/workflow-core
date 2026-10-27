// @vitest-environment node
/*
 * The warm-fraction log appends one line per real selection run, reads back
 * past malformed lines, and holds its verdict on mantahostels#385's 60-80% until
 * the band earns one (mantahostels#628, mantahostels#1428).
 *
 * Exercised against a throwaway root: pointing it at this repo would append to
 * the real measurement log.
 *
 * `pick-next.js` appends on every `/pick-next` run; loosen a case and a
 * selection run can fail on a log fault, or the summary confirms or refutes
 * mantahostels#385's claim on a band the runs do not support.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const {
	LOG_SUBPATH,
	MIN_RUNS,
	logPath,
	appendRun,
	readRuns,
	summarise,
	partition,
	readLastRunAt,
	DUP_WINDOW_MS,
	verdictOn,
	CLAIM,
	MIN_PROVISIONAL_RUNS,
	splitAtProvisional,
	coveredVerdictOn,
	boundVerdictOn,
} = require("./warm-fraction-log.js");

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "warm-fraction-"));
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

/** One run, in the shape `pick-next.js` hands over. */
const run = (warm: number, cold: number, causes: Record<string, number> = {}) =>
	appendRun(root, {
		frontier: warm + cold,
		warm: Array.from({ length: warm }, (_, i) => ({ number: i + 1 })),
		cold: Object.entries(causes).flatMap(([state, n]) =>
			Array.from({ length: n }, (_, i) => ({ number: 100 + i, state })),
		),
	});

describe("the cold causes", () => {
	/** The record `appendRun` writes for one run whose cold list holds `states`. */
	const recordFor = (...states: unknown[]) =>
		appendRun(root, {
			frontier: states.length,
			warm: [],
			cold: states.map((state, i) => ({ number: i + 1, state })),
		}).record;
	const causesOf = (...states: unknown[]) =>
		recordFor(...states).coldNumbers.map((c: { state: string }) => c.state);

	it("names a never-derived ticket `never`, not the store's `cold`", () => {
		expect(causesOf("cold")).toEqual(["never"]);
	});

	it("keeps `body-changed` and `path-gone`, which are the churn signal", () => {
		expect(causesOf("body-changed", "path-gone")).toEqual([
			"body-changed",
			"path-gone",
		]);
	});

	it("files a state it does not know under `unknown` rather than dropping it", () => {
		expect(causesOf("something-new", undefined)).toEqual([
			"unknown",
			"unknown",
		]);
	});

	it("tallies a mixed cold list by cause", () => {
		expect(
			recordFor("cold", "cold", "body-changed", "path-gone", "something-new")
				.causes,
		).toEqual({ never: 2, "body-changed": 1, "path-gone": 1, unknown: 1 });
	});
});

describe("appending a run", () => {
	it("writes one line per run under the gitignored cache dir", () => {
		run(3, 2, { cold: 2 });
		run(1, 1, { "body-changed": 1 });
		const lines = fs.readFileSync(logPath(root), "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(logPath(root)).toBe(path.join(root, LOG_SUBPATH));
	});

	it("records the frontier size, the split and the cold causes", () => {
		run(3, 2, { cold: 1, "body-changed": 1 });
		const [rec] = readRuns(root).runs;
		expect(rec.frontier).toBe(5);
		expect(rec.warm).toBe(3);
		expect(rec.cold).toBe(2);
		expect(rec.causes).toEqual({
			never: 1,
			"body-changed": 1,
			"path-gone": 0,
			unknown: 0,
		});
		expect(typeof rec.at).toBe("string");
	});

	it("records the puts counted since the previous run", () => {
		appendRun(root, { frontier: 1, warm: [], cold: [], puts: 4 });
		expect(readRuns(root).runs[0].putsSinceLastRun).toBe(4);
	});

	it("records a put count it was not given as null, never as nothing put", () => {
		appendRun(root, { frontier: 1, warm: [], cold: [] });
		appendRun(root, { frontier: 1, warm: [], cold: [], puts: null });
		for (const rec of readRuns(root).runs)
			expect(rec.putsSinceLastRun).toBeNull();
	});

	it("reports rather than throws when the log cannot be written", () => {
		fs.mkdirSync(path.dirname(logPath(root)), { recursive: true });
		// A directory where the log file goes: every write fails, forever.
		fs.mkdirSync(logPath(root));
		const r = appendRun(root, { frontier: 1, warm: [], cold: [] });
		expect(r.ok).toBe(false);
		expect(r.error).toBeTruthy();
	});
});

describe("reading the log back", () => {
	it("is empty, not an error, before any run has been recorded", () => {
		expect(readRuns(root)).toEqual({ runs: [], malformed: 0 });
	});

	it("skips a malformed line and counts it, keeping the runs either side", () => {
		run(1, 1, { cold: 1 });
		fs.appendFileSync(logPath(root), "{not json\n");
		run(2, 0);
		const { runs, malformed } = readRuns(root);
		expect(runs).toHaveLength(2);
		expect(malformed).toBe(1);
	});

	it("treats a line missing its counts as malformed rather than counting it as zero", () => {
		fs.mkdirSync(path.dirname(logPath(root)), { recursive: true });
		fs.writeFileSync(
			logPath(root),
			`${JSON.stringify({ at: "2026-08-19T00:00:00.000Z", warm: 1 })}\n`,
		);
		expect(readRuns(root)).toEqual({ runs: [], malformed: 1 });
	});
});

describe("the instant the last run was recorded", () => {
	it("is null before any run, so there is no interval to count puts over", () => {
		expect(readLastRunAt(root)).toBeNull();
	});

	it("is the newest timestamp, not the last line, since pickers append out of order", () => {
		fs.mkdirSync(path.dirname(logPath(root)), { recursive: true });
		for (const at of ["2026-08-19T09:00:00.000Z", "2026-08-19T08:00:00.000Z"])
			fs.appendFileSync(
				logPath(root),
				`${JSON.stringify({ at, frontier: 1, warm: 1, cold: 0 })}\n`,
			);
		expect(readLastRunAt(root)).toBe("2026-08-19T09:00:00.000Z");
	});
});

describe("summarising", () => {
	it("pools warm over frontier across runs, not the mean of the fractions", () => {
		const s = summarise([
			{ frontier: 10, warm: 9, cold: 1 },
			{ frontier: 90, warm: 0, cold: 90 },
		]);
		expect(s.pooled).toBeCloseTo(0.09, 6);
		expect(s.mean).toBeCloseTo(0.45, 6);
	});

	it("drops a zero-frontier run, which carries no fraction at all", () => {
		const s = summarise([
			{ frontier: 0, warm: 0, cold: 0 },
			{ frontier: 4, warm: 2, cold: 2 },
		]);
		expect(s.usableRuns).toBe(1);
		expect(s.pooled).toBeCloseTo(0.5, 6);
	});

	it("gives no band off a single run", () => {
		const s = summarise([{ frontier: 4, warm: 2, cold: 2 }]);
		expect(s.ci95).toBeNull();
	});

	it("widens the band on a spread and narrows it on agreement", () => {
		const steady = summarise(
			Array.from({ length: 4 }, () => ({ frontier: 10, warm: 5, cold: 5 })),
		);
		const spread = summarise([
			{ frontier: 10, warm: 0, cold: 10 },
			{ frontier: 10, warm: 10, cold: 0 },
			{ frontier: 10, warm: 0, cold: 10 },
			{ frontier: 10, warm: 10, cold: 0 },
		]);
		expect(steady.ci95).toBeCloseTo(0, 6);
		expect(spread.ci95).toBeGreaterThan(0.4);
	});

	it("holds the verdict until 10 real runs have been recorded", () => {
		const nine = summarise(
			Array.from({ length: MIN_RUNS - 1 }, () => ({
				frontier: 10,
				warm: 5,
				cold: 5,
			})),
		);
		const ten = summarise(
			Array.from({ length: MIN_RUNS }, () => ({
				frontier: 10,
				warm: 5,
				cold: 5,
			})),
		);
		expect(nine.enough).toBe(false);
		expect(ten.enough).toBe(true);
	});

	it("totals the cold causes and shares them over the cold entries", () => {
		const s = summarise([
			{
				frontier: 10,
				warm: 4,
				cold: 6,
				causes: { never: 3, "body-changed": 2, "path-gone": 1, unknown: 0 },
			},
			{
				frontier: 10,
				warm: 6,
				cold: 4,
				causes: { never: 1, "body-changed": 3, "path-gone": 0, unknown: 0 },
			},
		]);
		expect(s.causes).toEqual({
			never: 4,
			"body-changed": 5,
			"path-gone": 1,
			unknown: 0,
		});
		expect(s.causeShare["body-changed"]).toBeCloseTo(0.5, 6);
	});

	it("summarises nothing without inventing a fraction", () => {
		const s = summarise([]);
		expect(s.usableRuns).toBe(0);
		expect(s.pooled).toBeNull();
		expect(s.enough).toBe(false);
	});

	it("counts a ticket cold in two runs once, disagreeing with coldTotal (mantahostels#1428)", () => {
		const s = summarise([
			{
				frontier: 10,
				warm: 8,
				cold: 2,
				coldNumbers: [
					{ n: 1015, state: "body-changed" },
					{ n: 1055, state: "never" },
				],
			},
			{
				frontier: 10,
				warm: 9,
				cold: 1,
				coldNumbers: [{ n: 1015, state: "body-changed" }],
			},
		]);
		expect(s.coldTotal).toBe(3);
		expect(s.coldDistinctTickets).toBe(2);
	});

	it("gives no distinct tickets over a segment with a genuinely empty cold list (mantahostels#1428)", () => {
		const s = summarise([{ frontier: 10, warm: 10, cold: 0, coldNumbers: [] }]);
		expect(s.coldTotal).toBe(0);
		expect(s.coldDistinctTickets).toBe(0);
	});

	it("undercounts rather than inventing a ticket 0 where a cold entry's number is unreadable (mantahostels#1428)", () => {
		const s = summarise([
			{
				frontier: 10,
				warm: 7,
				cold: 3,
				// A number JSON round-trips as `null` (NaN's JSON form) or omits
				// entirely; neither is ticket `0`, which `Number(null) === 0`
				// would otherwise invent.
				coldNumbers: [
					{ n: null, state: "unknown" },
					{ n: undefined, state: "unknown" },
					{ n: 1015, state: "body-changed" },
				],
			},
		]);
		expect(s.coldTotal).toBe(3);
		expect(s.coldDistinctTickets).toBe(1);
	});
});

describe("the verdict on mantahostels#385's 60-80%", () => {
	/** A summary with `n` runs all at fraction `f`, plus an optional band. */
	const at = (f: number, n = 12, ci95: number | null = 0) => ({
		enough: n >= 10,
		usableRuns: n,
		pooled: f,
		mean: f,
		ci95,
	});

	it("states nothing at all under 10 runs, however clear the number looks", () => {
		expect(verdictOn(at(0.02, 4)).state).toBe("provisional");
		expect(verdictOn(at(0.99, 9)).state).toBe("provisional");
	});

	it("confirms only when the whole band sits inside the claim", () => {
		expect(verdictOn(at(0.7, 12, 0.05)).state).toBe("confirmed");
		expect(verdictOn(at(0.7, 12, 0.2)).state).toBe("inconclusive");
	});

	it("refutes only when the band and the claim do not meet", () => {
		expect(verdictOn(at(0.2, 12, 0.05)).state).toBe("refuted");
		expect(verdictOn(at(0.95, 12, 0.02)).state).toBe("refuted");
	});

	it("does not refute a low figure whose band still reaches the claim", () => {
		expect(verdictOn(at(0.55, 12, 0.1)).state).toBe("inconclusive");
	});

	it("reads the claim from one place, so a report cannot quote a different band", () => {
		expect(CLAIM).toEqual({ low: 0.6, high: 0.8, source: "mantahostels#385" });
	});

	it("stays provisional on a summary carrying no fraction at all", () => {
		expect(verdictOn(summarise([])).state).toBe("provisional");
	});
});

describe("what the log keeps that counts alone cannot recover", () => {
	it("stores the issue numbers on both sides, so a re-pick can be told from a first pick", () => {
		appendRun(root, {
			frontier: 3,
			warm: [{ number: 11 }, { number: 12 }],
			cold: [{ number: 13, state: "body-changed" }],
		});
		const [rec] = readRuns(root).runs;
		expect(rec.warmNumbers).toEqual([11, 12]);
		expect(rec.coldNumbers).toEqual([{ n: 13, state: "body-changed" }]);
	});

	it("counts a hit that skipped the rename check separately from a clean one", () => {
		appendRun(root, {
			frontier: 2,
			warm: [{ number: 1 }, { number: 2, unrevalidated: true }],
			cold: [],
		});
		const [rec] = readRuns(root).runs;
		expect(rec.warm).toBe(2);
		expect(rec.unrevalidatedWarm).toBe(1);
		expect(summarise([rec]).unrevalidatedWarmTotal).toBe(1);
	});

	it("degrades rather than throwing when handed a cold list of the wrong shape", () => {
		// `write-set-cache.js` degrades on a wrong-shaped caller; so must this,
		// since throwing here would fail a selection run to protect a measurement.
		expect(() =>
			appendRun(root, { frontier: 1, warm: [], cold: 42 }),
		).not.toThrow();
		const [rec] = readRuns(root).runs;
		expect(rec.cold).toBe(0);
		expect(rec.causes).toEqual({
			never: 0,
			"body-changed": 0,
			"path-gone": 0,
			unknown: 0,
		});
	});

	it("does not throw when handed no lists at all", () => {
		expect(() => appendRun(root, { frontier: 0 })).not.toThrow();
	});
});

describe("the band", () => {
	it("uses Student's t, not 1.96, at the run counts this tool actually sees", () => {
		// Four runs at 0 and 100: sample sd is 0.5774, df = 3, t = 3.182.
		const s = summarise([
			{ frontier: 10, warm: 0, cold: 10 },
			{ frontier: 10, warm: 10, cold: 0 },
			{ frontier: 10, warm: 0, cold: 10 },
			{ frontier: 10, warm: 10, cold: 0 },
		]);
		expect(s.sd).toBeCloseTo(0.577_350_269_2, 6);
		expect(s.ci95).toBeCloseTo((3.182 * 0.577_350_269_2) / 2, 6);
	});

	it("divides by n-1, so the spread is not understated as if these were every run there is", () => {
		const s = summarise([
			{ frontier: 10, warm: 2, cold: 8 },
			{ frontier: 10, warm: 8, cold: 2 },
		]);
		// The population sd would be 0.3.
		expect(s.sd).toBeCloseTo(0.424_264_068_7, 6);
	});

	it("falls back to the normal beyond the table, where the two agree", () => {
		const s = summarise(
			Array.from({ length: 40 }, (_, i) => ({
				frontier: 10,
				warm: i % 2 ? 4 : 6,
				cold: i % 2 ? 6 : 4,
			})),
		);
		expect(s.ci95).toBeCloseTo((1.96 * s.sd) / Math.sqrt(40), 6);
	});
});

describe("which figure the verdict judges", () => {
	it("judges the cost-weighted pooled figure, not the mean of the run fractions", () => {
		const runs = [
			...Array.from({ length: 10 }, () => ({
				frontier: 1,
				warm: 1,
				cold: 0,
			})),
			{ frontier: 110, warm: 0, cold: 110 },
		];
		const s = summarise(runs);
		expect(s.mean).toBeGreaterThan(0.9);
		expect(s.pooled).toBeLessThan(0.1);
		const v = verdictOn(s);
		expect(v.point).toBeCloseTo(s.pooled, 6);
		expect(v.low).toBeCloseTo(s.pooled - s.ci95, 6);
		expect(v.high).toBeCloseTo(s.pooled + s.ci95, 6);
	});

	it("says which side of the claim a refutation fell on, since only one is bad news", () => {
		const low = summarise(
			Array.from({ length: 12 }, () => ({ frontier: 10, warm: 1, cold: 9 })),
		);
		const high = summarise(
			Array.from({ length: 12 }, () => ({ frontier: 10, warm: 10, cold: 0 })),
		);
		expect(verdictOn(low)).toMatchObject({ state: "refuted", side: "below" });
		expect(verdictOn(high)).toMatchObject({ state: "refuted", side: "above" });
	});

	it("names no side where the claim was not refuted at all", () => {
		const s = summarise(
			Array.from({ length: 12 }, () => ({ frontier: 10, warm: 7, cold: 3 })),
		);
		expect(verdictOn(s).side).toBeNull();
	});
});

describe("collapsing duplicate runs", () => {
	/** A record in the shape the log stores, with the numbers a dedup needs. */
	const rec = (
		timestamp: string,
		session: string | null,
		{
			warm: warmNumbers,
			cold: coldNumbers,
			puts,
		}: { warm: number[]; cold: number[]; puts?: number },
	) => ({
		at: timestamp,
		frontier: warmNumbers.length + coldNumbers.length,
		warm: warmNumbers.length,
		cold: coldNumbers.length,
		warmNumbers,
		coldNumbers: coldNumbers.map((n) => ({ n, state: "never" })),
		session,
		...(puts === undefined ? {} : { putsSinceLastRun: puts }),
	});

	it("drops a re-run for --json: same session, same frontier, same split, minutes apart", () => {
		const runs = [
			rec("2026-08-19T08:14:08.000Z", "s1", { warm: [1, 2], cold: [3, 4] }),
			rec("2026-08-19T08:14:50.000Z", "s1", { warm: [1, 2], cold: [3, 4] }),
		];
		const { distinct: kept, collapsed } = partition(runs);
		expect(kept).toHaveLength(1);
		expect(collapsed).toMatchObject({ total: 1, sameSession: 1 });
	});

	it("keeps a genuine second re-pick by the same session, whose split has moved", () => {
		const runs = [
			rec("2026-08-19T08:14:08.000Z", "s1", { warm: [1], cold: [2, 3, 4] }),
			// The first run's `put`s warmed two of them.
			rec("2026-08-19T08:14:50.000Z", "s1", { warm: [1, 2, 3], cold: [4] }),
		];
		expect(partition(runs).distinct).toHaveLength(2);
	});

	it("keeps a repeat far enough apart to be its own observation of the churn", () => {
		const runs = [
			rec("2026-08-19T08:00:00.000Z", "s1", { warm: [1, 2], cold: [3, 4] }),
			rec("2026-08-19T09:00:00.000Z", "s1", { warm: [1, 2], cold: [3, 4] }),
		];
		expect(partition(runs).distinct).toHaveLength(2);
	});

	it("keeps a run over a different frontier, however close in time", () => {
		const runs = [
			rec("2026-08-19T08:14:08.000Z", "s1", { warm: [1, 2], cold: [3, 4] }),
			rec("2026-08-19T08:14:10.000Z", "s1", { warm: [1, 2], cold: [3, 5] }),
		];
		expect(partition(runs).distinct).toHaveLength(2);
	});

	it("collapses a parallel session's near-duplicate too, and says so separately", () => {
		const runs = [
			rec("2026-08-19T08:14:08.000Z", "s1", { warm: [1, 2], cold: [3, 4] }),
			rec("2026-08-19T08:14:50.000Z", "s2", { warm: [1, 2], cold: [3, 4] }),
		];
		const { distinct: kept, collapsed } = partition(runs);
		expect(kept).toHaveLength(1);
		expect(collapsed).toMatchObject({
			total: 1,
			sameSession: 0,
			crossSession: 1,
		});
	});

	it("measures the window from the run it kept, so a stream cannot chain past it", () => {
		const runs = [
			rec("2026-08-19T08:00:00.000Z", "s1", { warm: [1, 2], cold: [3, 4] }),
			rec("2026-08-19T08:08:00.000Z", "s1", { warm: [1, 2], cold: [3, 4] }),
			rec("2026-08-19T08:16:00.000Z", "s1", { warm: [1, 2], cold: [3, 4] }),
		];
		const { distinct: kept, collapsed } = partition(runs);
		expect(kept).toHaveLength(2);
		expect(collapsed.total).toBe(1);
	});

	it("keeps a run whose issue numbers are absent, which cannot be judged a duplicate", () => {
		const runs = [
			{ at: "2026-08-19T08:14:08.000Z", frontier: 4, warm: 2, cold: 2 },
			{ at: "2026-08-19T08:14:50.000Z", frontier: 4, warm: 2, cold: 2 },
		];
		expect(partition(runs).distinct).toHaveLength(2);
	});

	it("keeps a run with no readable timestamp rather than guessing its window", () => {
		// Both unreadable: a reader that treated a missing time as one instant
		// would place them in the same window and drop the second.
		const runs = [
			rec("nonsense", "s1", { warm: [1, 2], cold: [3, 4] }),
			rec("nonsense", "s1", { warm: [1, 2], cold: [3, 4] }),
		];
		expect(partition(runs).distinct).toHaveLength(2);
	});

	it("keeps two runs over the same tickets whose warm and cold sides swapped", () => {
		// Same frontier, same counts: a size-keyed reader would call these one
		// observation, and the crossing is exactly the churn being measured.
		const runs = [
			rec("2026-08-19T08:00:00.000Z", "s1", { warm: [1, 2], cold: [3, 4] }),
			rec("2026-08-19T08:05:00.000Z", "s1", { warm: [3, 4], cold: [1, 2] }),
		];
		expect(partition(runs).distinct).toHaveLength(2);
	});

	it("keeps a run whose cold tickets went cold for a new reason", () => {
		const first = rec("2026-08-19T08:00:00.000Z", "s1", {
			warm: [1],
			cold: [2],
		});
		const second = rec("2026-08-19T08:05:00.000Z", "s1", {
			warm: [1],
			cold: [2],
		});
		second.coldNumbers = [{ n: 2, state: "body-changed" }];
		expect(partition([first, second]).distinct).toHaveLength(2);
	});

	it("voids the key on an unreadable issue number rather than shrinking it", () => {
		const a = rec("2026-08-19T08:00:00.000Z", "s1", {
			warm: [1, 2],
			cold: [3],
		});
		const b = rec("2026-08-19T08:05:00.000Z", "s1", {
			warm: [1, 2],
			cold: [3],
		});
		b.warmNumbers = [1, 2, Number.NaN];
		expect(partition([a, b]).distinct).toHaveLength(2);
	});

	it("judges in time order, so which lines survive does not depend on write order", () => {
		const at = (m: number) =>
			`2026-08-19T08:${String(m).padStart(2, "0")}:00.000Z`;
		const outOfOrder = [at(0), at(30), at(10), at(20)].map((t) =>
			rec(t, "s1", { warm: [1, 2], cold: [3, 4] }),
		);
		const kept = partition(outOfOrder).distinct;
		expect(kept).toHaveLength(2);
		// Windows run 0-10 and 20-30, so 10 and 30 go; returned as written.
		expect(kept.map((r: { at: string }) => r.at)).toEqual([at(0), at(20)]);
	});

	it("collapses at exactly the window and keeps a run one millisecond past it", () => {
		const start = Date.parse("2026-08-19T08:00:00.000Z");
		const pair = (gap: number) => [
			rec(new Date(start).toISOString(), "s1", { warm: [1], cold: [2] }),
			rec(new Date(start + gap).toISOString(), "s1", { warm: [1], cold: [2] }),
		];
		expect(partition(pair(DUP_WINDOW_MS)).distinct).toHaveLength(1);
		expect(partition(pair(DUP_WINDOW_MS + 1)).distinct).toHaveLength(2);
	});

	it("attributes a collapse to no session where either record names none", () => {
		const runs = [
			rec("2026-08-19T08:00:00.000Z", null, { warm: [1], cold: [2] }),
			rec("2026-08-19T08:05:00.000Z", "s1", { warm: [1], cold: [2] }),
		];
		expect(partition(runs).collapsed).toMatchObject({
			total: 1,
			sameSession: 0,
			crossSession: 0,
			unknownSession: 1,
		});
	});

	it("excludes a duplicate from the pooled fraction and from usableRuns", () => {
		const cold = rec("2026-08-19T08:00:00.000Z", "s1", {
			warm: [1],
			cold: [2, 3, 4],
		});
		const dup = rec("2026-08-19T08:00:30.000Z", "s1", {
			warm: [1],
			cold: [2, 3, 4],
		});
		const warm = rec("2026-08-19T09:00:00.000Z", "s2", {
			warm: [5, 6, 7],
			cold: [8],
		});
		const s = summarise([cold, dup, warm]);
		expect(s.totalRuns).toBe(3);
		expect(s.usableRuns).toBe(2);
		// 1+3 warm of 8 frontier, not 2+3 of 12.
		expect(s.pooled).toBeCloseTo(0.5, 6);
		expect(s.collapsedRuns).toBe(1);
	});

	it("reaches the verdict floor on real observations, not on repeats of one", () => {
		const runs = Array.from({ length: MIN_RUNS }, (_, i) =>
			rec(`2026-08-19T08:00:${String(i).padStart(2, "0")}.000Z`, "s1", {
				warm: [1, 2],
				cold: [3, 4],
			}),
		);
		expect(summarise(runs).enough).toBe(false);
	});
	it("keeps a run something was put before, which cannot be a re-record of the last one", () => {
		const runs = [
			rec("2026-08-19T08:00:00.000Z", "s1", { warm: [1], cold: [2] }),
			rec("2026-08-19T08:05:00.000Z", "s1", { warm: [1], cold: [2], puts: 1 }),
		];
		const { distinct: kept, collapsed } = partition(runs);
		expect(kept).toHaveLength(2);
		expect(collapsed).toMatchObject({ total: 0, keptOnPuts: 1 });
	});

	it("counts a kept run matching a parallel session apart, that being what mantahostels#650 collapsed", () => {
		const pair = (session: string) => [
			rec("2026-08-19T08:00:00.000Z", "s1", { warm: [1], cold: [2] }),
			rec("2026-08-19T08:02:00.000Z", session, {
				warm: [1],
				cold: [2],
				puts: 1,
			}),
		];
		expect(partition(pair("s2")).collapsed).toMatchObject({
			keptOnPuts: 1,
			keptOnPutsCrossSession: 1,
		});
		expect(partition(pair("s1")).collapsed).toMatchObject({
			keptOnPuts: 1,
			keptOnPutsCrossSession: 0,
		});
	});

	it("collapses a run that recorded a put of zero, and counts that residual apart", () => {
		const runs = [
			rec("2026-08-19T08:00:00.000Z", "s1", { warm: [1], cold: [2], puts: 0 }),
			rec("2026-08-19T08:05:00.000Z", "s1", { warm: [1], cold: [2], puts: 0 }),
		];
		const { distinct: kept, collapsed } = partition(runs);
		expect(kept).toHaveLength(1);
		expect(collapsed).toMatchObject({ total: 1, quiet: 1, putsUnknown: 0 });
	});

	it("collapses a line predating the put count, counted apart from a measured zero", () => {
		const runs = [
			rec("2026-08-19T08:00:00.000Z", "s1", { warm: [1], cold: [2] }),
			rec("2026-08-19T08:05:00.000Z", "s1", { warm: [1], cold: [2] }),
		];
		expect(partition(runs).collapsed).toMatchObject({
			total: 1,
			quiet: 0,
			putsUnknown: 1,
		});
	});

	it("reads the `puts` field two live log lines carry, so they are not treated as unable to say", () => {
		// Two runs on the real log carry `puts` rather than `putsSinceLastRun`.
		const withPuts = (timestamp: string, puts: number) => ({
			...rec(timestamp, "s1", { warm: [1], cold: [2] }),
			puts,
		});
		const above = [
			rec("2026-08-19T08:00:00.000Z", "s1", { warm: [1], cold: [2] }),
			withPuts("2026-08-19T08:05:00.000Z", 1),
		];
		expect(partition(above)).toMatchObject({
			collapsed: { total: 0, keptOnPuts: 1 },
		});
		const zero = [
			rec("2026-08-19T09:00:00.000Z", "s1", { warm: [1], cold: [2] }),
			withPuts("2026-08-19T09:05:00.000Z", 0),
		];
		expect(partition(zero).collapsed).toMatchObject({
			total: 1,
			quiet: 1,
			putsUnknown: 0,
		});
	});

	it("anchors the next window on a run kept for its puts, not on the one before it", () => {
		const runs = [
			rec("2026-08-19T08:00:00.000Z", "s1", { warm: [1], cold: [2] }),
			rec("2026-08-19T08:09:00.000Z", "s1", { warm: [1], cold: [2], puts: 2 }),
			rec("2026-08-19T08:14:00.000Z", "s1", { warm: [1], cold: [2], puts: 0 }),
		];
		// The third is 14 minutes past the first and so outside its window, but
		// 5 past the second, which is now the anchor.
		expect(partition(runs).distinct).toHaveLength(2);
	});

	it("counts a kept-on-puts run and both collapse residuals in the summary", () => {
		const s = summarise([
			rec("2026-08-19T08:00:00.000Z", "s1", { warm: [1], cold: [2] }),
			rec("2026-08-19T08:01:00.000Z", "s1", { warm: [1], cold: [2] }),
			rec("2026-08-19T08:02:00.000Z", "s1", { warm: [1], cold: [2], puts: 0 }),
			rec("2026-08-19T08:03:00.000Z", "s1", { warm: [1], cold: [2], puts: 3 }),
		]);
		expect(s.usableRuns).toBe(2);
		expect(s.collapsedRuns).toBe(2);
		expect(s.collapsedQuiet).toBe(1);
		expect(s.collapsedPutsUnknown).toBe(1);
		expect(s.runsKeptOnPuts).toBe(1);
	});
});

describe("provisional entries, kept apart from warm (mantahostels#1001)", () => {
	/** One run with a pre-warmed slice, in the shape `pick-next.js` hands over. */
	const runWith = (
		warm: number[],
		provisional: number[],
		cold: number[] = [],
	) =>
		appendRun(root, {
			frontier: warm.length + provisional.length + cold.length,
			warm: warm.map((n) => ({ number: n })),
			provisional: provisional.map((n) => ({ number: n })),
			cold: cold.map((n) => ({ number: n, state: "cold" })),
		});

	it("counts them on their own line, never inside warm", () => {
		/*
		 * Folding them in would drive every line towards 100% and make mantahostels#385's
		 * 60-80% claim untestable — a prediction is not a band read.
		 */
		runWith([1], [2, 3]);
		const rec = readRuns(root).runs[0];
		expect(rec.warm).toBe(1);
		expect(rec.provisional).toBe(2);
		expect(rec.provisionalNumbers).toEqual([2, 3]);
	});

	it("leaves pooled as band-read warmth alone", () => {
		runWith([1], [2, 3]);
		expect(summarise(readRuns(root).runs).pooled).toBeCloseTo(1 / 3);
	});

	it("reports the covered share separately — the fraction a band read may skip", () => {
		runWith([1], [2, 3]);
		const s = summarise(readRuns(root).runs);
		expect(s.pooledCovered).toBe(1);
		expect(s.provisionalTotal).toBe(2);
		expect(s.runsWithProvisional).toBe(1);
	});

	it("reads a line predating the field as no provisional tickets, not as a gap", () => {
		// No run before mantahostels#1001 wrote one, so zero is the truth for those lines.
		fs.mkdirSync(path.dirname(logPath(root)), { recursive: true });
		fs.writeFileSync(
			logPath(root),
			`${JSON.stringify({
				at: "2026-08-19T08:00:00.000Z",
				frontier: 2,
				warm: 1,
				cold: 1,
				warmNumbers: [1],
				coldNumbers: [{ n: 2, state: "never" }],
			})}\n`,
		);
		const s = summarise(readRuns(root).runs);
		expect(s.provisionalTotal).toBe(0);
		expect(s.runsWithProvisional).toBe(0);
		expect(s.pooledCovered).toBeCloseTo(0.5);
	});

	it("keeps two runs distinct when only the provisional membership differs", () => {
		/*
		 * A frontier that has grown by one pre-warmed ticket is a second
		 * observation of the churn, not a second record of the run before it — and
		 * the warm and cold lists are identical, so the provisional list is the
		 * only thing that can tell them apart.
		 */
		runWith([1], []);
		runWith([1], [2]);
		const { distinct: runs, collapsed } = partition(readRuns(root).runs);
		expect(runs).toHaveLength(2);
		expect(collapsed.total).toBe(0);
	});

	it("still collapses a re-run whose provisional set is identical", () => {
		runWith([1], [2]);
		runWith([1], [2]);
		expect(partition(readRuns(root).runs).collapsed.total).toBe(1);
	});
});

/** One line written straight to the log, so its instant and shape are controlled. */
const raw = (rec: Record<string, unknown>) => {
	fs.mkdirSync(path.dirname(logPath(root)), { recursive: true });
	fs.appendFileSync(logPath(root), `${JSON.stringify(rec)}\n`);
};

/**
 * A run at a chosen minute, with a frontier nothing else shares so the
 * de-duplication window never reaches it — `sharedFrontier` opts out of that,
 * for the one case that needs a duplicate. A `null` `prov` writes no
 * `provisional` key at all, which is how every line predating mantahostels#1001 reads.
 */
const at = (
	minute: number,
	prov: number | null,
	opts: {
		warm?: number;
		cold?: number;
		sharedFrontier?: boolean;
		puts?: number;
		instant?: string;
	} = {},
) => {
	const { warm = 1, cold = 1 } = opts;
	// A shared frontier reuses one base, so two lines key identically and the
	// de-duplication window can reach them.
	const base = opts.sharedFrontier ? 0 : minute * 1000;
	const rec: Record<string, unknown> = {
		at:
			opts.instant ?? new Date(Date.UTC(2026, 7, 19, 0, minute)).toISOString(),
		frontier: warm + cold + (prov ?? 0),
		warm,
		cold,
		causes: { never: cold, "body-changed": 0, "path-gone": 0, unknown: 0 },
		warmNumbers: Array.from({ length: warm }, (_, i) => base + i),
		coldNumbers: Array.from({ length: cold }, (_, i) => ({
			n: base + 500 + i,
			state: "never",
		})),
		putsSinceLastRun: opts.puts ?? 1,
	};
	if (prov !== null) {
		rec.provisional = prov;
		rec.provisionalNumbers = Array.from(
			{ length: prov },
			(_, i) => base + 900 + i,
		);
	}
	raw(rec);
};

describe("splitting the log where pre-warming starts (mantahostels#1054)", () => {
	it("names no split point while no line carries the field", () => {
		at(1, null);
		at(2, null);
		const split = splitAtProvisional(readRuns(root).runs);
		expect(split.splitAt).toBeNull();
		expect(split.after).toBeNull();
		expect(split.before.usableRuns).toBe(2);
	});

	it("splits on the field's presence, never on a non-zero count", () => {
		at(1, null);
		at(2, 0);
		at(3, 2);
		const split = splitAtProvisional(readRuns(root).runs);
		expect(split.before.usableRuns).toBe(1);
		expect(split.after.usableRuns).toBe(2);
		expect(split.splitAt).toBe(
			new Date(Date.UTC(2026, 7, 19, 0, 2)).toISOString(),
		);
	});

	it("summarises each side apart, so covered is never pooled across the change", () => {
		// Before: 1 warm of 2. After: 1 warm + 2 provisional of 4.
		at(1, null);
		at(2, 2);
		const split = splitAtProvisional(readRuns(root).runs);
		expect(split.before.pooledCovered).toBeCloseTo(0.5);
		expect(split.after.pooledCovered).toBeCloseTo(0.75);
		expect(split.after.pooled).toBeCloseTo(0.25);
	});

	it("splits in time order, not file order — parallel pickers append out of order", () => {
		at(3, 2);
		at(1, null);
		const split = splitAtProvisional(readRuns(root).runs);
		expect(split.before.usableRuns).toBe(1);
		expect(split.after.usableRuns).toBe(1);
	});

	it("drops duplicates before splitting, so one observation cannot count on both sides", () => {
		/*
		 * The pair straddles the boundary: same frontier, minutes apart, nothing
		 * put between — one line predating the `provisional` field and one
		 * carrying it empty. Collapsing each side separately would keep the
		 * second, which would then become the split point off one observation.
		 */
		at(1, null, { sharedFrontier: true, puts: 0 });
		at(3, 0, { sharedFrontier: true, puts: 0 });
		const split = splitAtProvisional(readRuns(root).runs);
		expect(split.splitAt).toBeNull();
		expect(split.before.usableRuns).toBe(1);
		expect(split.after).toBeNull();
	});

	it("places no run on a side when its instant cannot be read", () => {
		/*
		 * A defaulted instant sorted such a line to the epoch, where a pre-warming
		 * one among them took the split point and left `before` empty — voiding
		 * the comparison rather than reporting it.
		 */
		at(1, null);
		at(2, null);
		at(3, 2, { instant: "not-a-date" });
		const split = splitAtProvisional(readRuns(root).runs);
		expect(split.splitAt).toBeNull();
		expect(split.undated).toBe(1);
		expect(split.before.usableRuns).toBe(2);
	});

	it("keeps the endpoints and the span reading the same window", () => {
		// Appended out of order, so file order would print a window the span
		// beneath it contradicts.
		at(90, null);
		at(0, null);
		const s = summarise(readRuns(root).runs);
		expect(s.first).toBe(new Date(Date.UTC(2026, 7, 19, 0, 0)).toISOString());
		expect(s.last).toBe(new Date(Date.UTC(2026, 7, 19, 1, 30)).toISOString());
		expect(Date.parse(s.last) - Date.parse(s.first)).toBe(s.windowMs);
	});
});

describe("the covered figure's own verdict floor (mantahostels#1054)", () => {
	const provisionalRuns = (n: number) => {
		for (let i = 1; i <= n; i += 1) at(i, 2);
	};

	it("refuses a covered verdict under ten runs carrying a provisional count", () => {
		provisionalRuns(4);
		const v = coveredVerdictOn(summarise(readRuns(root).runs));
		expect(v.state).toBe("provisional");
		expect(v.runs).toBe(4);
		expect(v.need).toBe(MIN_PROVISIONAL_RUNS);
	});

	it("states it once ten such runs exist", () => {
		provisionalRuns(MIN_PROVISIONAL_RUNS);
		const s = summarise(readRuns(root).runs);
		const v = coveredVerdictOn(s);
		expect(v.state).toBe("measured");
		expect(v.point).toBeCloseTo(s.pooledCovered);
	});

	it("counts only a non-zero provisional towards the floor", () => {
		for (let i = 1; i <= MIN_PROVISIONAL_RUNS; i += 1) at(i, 0);
		expect(coveredVerdictOn(summarise(readRuns(root).runs)).state).toBe(
			"provisional",
		);
	});

	it("is gated apart from pooled's verdict — the two rest on different samples", () => {
		for (let i = 1; i <= MIN_RUNS; i += 1) at(i, null);
		const s = summarise(readRuns(root).runs);
		expect(verdictOn(s).state).not.toBe("provisional");
		expect(coveredVerdictOn(s).state).toBe("provisional");
	});
});

describe("the covered bound, which only ever refutes (mantahostels#1327)", () => {
	/** A summary with just what `boundVerdictOn` and `coveredVerdictOn` read. */
	const summaryAt = (
		pooledCovered: number | null,
		runsWithProvisional: number,
		coveredCi95: number | null = 0,
	) => ({ pooledCovered, runsWithProvisional, coveredCi95 });

	it("is provisional wherever coveredVerdictOn itself is", () => {
		expect(boundVerdictOn(summaryAt(null, 0))).toMatchObject({
			state: "provisional",
			runs: 0,
			need: MIN_PROVISIONAL_RUNS,
		});
	});

	it("refutes the claim where the WHOLE band falls below the claim's low end", () => {
		expect(
			boundVerdictOn(summaryAt(CLAIM.low - 0.01, MIN_PROVISIONAL_RUNS)),
		).toMatchObject({ state: "refuted", point: CLAIM.low - 0.01 });
	});

	it("does not refute on a point estimate whose band still reaches the claim", () => {
		// A midpoint test would refute this; the whole point of taking the band
		// is that it must not.
		expect(
			boundVerdictOn(summaryAt(CLAIM.low - 0.01, MIN_PROVISIONAL_RUNS, 0.05)),
		).toMatchObject({ state: "inconclusive" });
	});

	it("never confirms — a bound inside or above the claim is only inconclusive", () => {
		expect(
			boundVerdictOn(summaryAt(CLAIM.low + 0.05, MIN_PROVISIONAL_RUNS)),
		).toMatchObject({ state: "inconclusive" });
		expect(
			boundVerdictOn(summaryAt(0.998, MIN_PROVISIONAL_RUNS)),
		).toMatchObject({ state: "inconclusive", point: 0.998 });
	});
});

describe("the window a figure was read over (mantahostels#789)", () => {
	it("reports the span, not only its endpoints", () => {
		at(0, null);
		at(90, null);
		expect(summarise(readRuns(root).runs).windowMs).toBe(90 * 60 * 1000);
	});

	it("has no span before the first run", () => {
		expect(summarise([]).windowMs).toBeNull();
	});
});
