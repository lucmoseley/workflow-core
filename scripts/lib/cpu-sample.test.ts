// @vitest-environment node
/*
 * Pins cpu-sample.js's CPU split across a run (mantahostels#1953) and the load
 * ceiling new work waits under (#830). The module reads /proc, so the
 * arithmetic is exercised on FABRICATED samples — the same shape `markerFrom`
 * is tested in, and the only way to assert a figure against a known answer. The
 * two live reads get one smoke test each, skipped where /proc is absent.
 *
 * admission.js, pick-next.js and run-vitest.js hold test runs and session launches on
 * `overloadReading`, so a loosened case lets new work start on a machine
 * already saturated, or holds work on
 * a misread figure.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const {
	sample,
	delta,
	FIELDS,
	overloadReading,
	buildOverloadText,
	sessionCeiling,
	holdForLoad,
} = require("./cpu-sample.js");

const hasProc = fs.existsSync("/proc/stat");

/* Build a sample from named jiffie counts; anything unnamed is 0. */
function fab(counts: Record<string, number>, load1: number | null = 1.5) {
	const jiffies: Record<string, number> = {};
	let total = 0;
	for (const f of FIELDS as string[]) {
		jiffies[f] = counts[f] ?? 0;
		total += jiffies[f];
	}
	return { jiffies, total, load1 };
}

describe("delta — the arithmetic", () => {
	it("reports busy as a share of the whole ceiling, not of one core", () => {
		// 400 busy jiffies of an 800-jiffie span on 8 cores = half the machine.
		const before = fab({});
		const after = fab({ system: 400, idle: 400 });
		const d = delta(before, after, 8);
		expect(d.ceilingPct).toBe(800);
		expect(d.busyPct).toBe(400);
	});

	it("splits system, nice and user rather than reporting one total", () => {
		const before = fab({});
		const after = fab({ system: 500, nice: 300, user: 100, idle: 100 });
		const d = delta(before, after, 8);
		expect(d.busyPct).toBe(720); // 900/1000 of 800
		expect(d.systemPct).toBe(400);
		expect(d.nicePct).toBe(240);
		expect(d.userPct).toBe(80);
	});

	/*
	 * The finding the split exists for (mantahostels#1953): a Claude session runs at NI 5, so
	 * a machine at 88% of its ceiling reads 8% `user`. A reader watching `user`
	 * alone would call this idle.
	 */
	it("keeps a niced-session-dominated machine from reading as idle in user", () => {
		const d = delta(
			fab({}),
			fab({ nice: 400, system: 500, user: 100, idle: 100 }),
			8,
		);
		expect(d.userPct).toBeLessThan(100);
		expect(d.busyPct).toBeGreaterThan(700);
	});

	it("excludes iowait from busy and still reports it", () => {
		const d = delta(fab({}), fab({ system: 600, iowait: 200, idle: 200 }), 8);
		// iowait is not the CPU running anything: 600/1000, not 800/1000.
		expect(d.busyPct).toBe(480);
		expect(d.iowaitPct).toBe(160);
	});

	it("takes load1 from the end sample, describing the window the run met", () => {
		const d = delta(fab({}, 2), fab({ idle: 100 }, 42.5), 8);
		expect(d.load1).toBe(42.5);
	});

	it("scales the ceiling with the core count", () => {
		const before = fab({});
		const after = fab({ system: 500, idle: 500 });
		expect(delta(before, after, 8).busyPct).toBe(400);
		expect(delta(before, after, 4).busyPct).toBe(200);
		expect(delta(before, after, 4).ceilingPct).toBe(400);
	});
});

describe("delta — what it refuses rather than guessing", () => {
	/*
	 * The load-bearing one. A zero or negative span divided into is nonsense, and
	 * a `busyPct: 0` written to a marker reads as a MEASURED idle machine — the
	 * exact false reading these fields exist to prevent.
	 */
	it("returns null on a zero span rather than a measured-looking zero", () => {
		const s = fab({ idle: 100 });
		expect(delta(s, s, 8)).toBeNull();
	});

	it("returns null when the counter went backwards", () => {
		expect(delta(fab({ idle: 500 }), fab({ idle: 100 }), 8)).toBeNull();
	});

	it("returns null on a missing sample at either end", () => {
		expect(delta(null, fab({ idle: 100 }), 8)).toBeNull();
		expect(delta(fab({}), null, 8)).toBeNull();
	});

	it("returns null when the core count is unknown, never dividing by zero", () => {
		expect(delta(fab({}), fab({ idle: 100 }), 0)).toBeNull();
	});
});

describe("sample — parsing /proc/stat", () => {
	it.skipIf(!hasProc)("reads the live machine and totals its jiffies", () => {
		const s = sample();
		expect(s).not.toBeNull();
		expect(s.total).toBeGreaterThan(0);
		for (const f of FIELDS as string[])
			expect(typeof s.jiffies[f]).toBe("number");
	});

	it.skipIf(!hasProc)("takes two samples that advance", () => {
		const a = sample();
		// Busy-wait rather than sleep: the span must be > 0 jiffies, not > 0 ms.
		const until = Date.now() + 60;
		while (Date.now() < until) {
			/* spin */
		}
		const b = sample();
		expect(b.total).toBeGreaterThan(a.total);
		const d = delta(a, b, 8);
		expect(d).not.toBeNull();
		expect(d.busyPct).toBeGreaterThanOrEqual(0);
	});

	it.skipIf(!hasProc)("reads a load average off the live machine", () => {
		expect(sample().load1).toBeGreaterThanOrEqual(0);
	});
});

/*
 * #830: the ceiling is 3 per core — its derivation is at
 * `LOAD_PER_CORE_CEILING`.
 */
describe("overloadReading — the load ceiling new work waits under (#830)", () => {
	it("sits at 3 per core, 24 on 8 cores", () => {
		expect(overloadReading({ load1: 0, cores: 8, env: {} }).ceiling).toBe(24);
	});

	it("is overloaded at the ceiling and not just under it", () => {
		expect(overloadReading({ load1: 24, cores: 8, env: {} }).overloaded).toBe(
			true,
		);
		expect(
			overloadReading({ load1: 23.99, cores: 8, env: {} }).overloaded,
		).toBe(false);
	});

	it("takes WFC_LOAD_CEILING over the default", () => {
		const r = overloadReading({
			load1: 30,
			cores: 8,
			env: { WFC_LOAD_CEILING: "48" },
		});
		expect(r).toEqual({ overloaded: false, load1: 30, ceiling: 48 });
	});

	describe("the host file ~/.claude/load-ceiling (#3223)", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "load-ceiling-"));
		fs.mkdirSync(path.join(home, ".claude"));
		fs.writeFileSync(path.join(home, ".claude", "load-ceiling"), "48\n");
		afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

		it("overrides the default where WFC_LOAD_CEILING is unset", () => {
			expect(
				overloadReading({ load1: 0, cores: 8, env: { HOME: home } }).ceiling,
			).toBe(48);
		});

		it("gives way to WFC_LOAD_CEILING, an empty one included", () => {
			const at = (WfcLoadCeiling: string) =>
				overloadReading({
					load1: 0,
					cores: 8,
					env: { HOME: home, WFC_LOAD_CEILING: WfcLoadCeiling },
				}).ceiling;
			expect(at("16")).toBe(16);
			expect(at("")).toBe(24);
		});

		it("is no override, and no problem, where it is absent", () => {
			const bare = fs.mkdtempSync(path.join(os.tmpdir(), "no-ceiling-"));
			try {
				expect(
					overloadReading({ load1: 0, cores: 8, env: { HOME: bare } }),
				).toEqual({ overloaded: false, load1: 0, ceiling: 24 });
			} finally {
				fs.rmSync(bare, { recursive: true, force: true });
			}
		});

		it("keeps the default and names the problem where it holds no number", () => {
			const odd = fs.mkdtempSync(path.join(os.tmpdir(), "odd-ceiling-"));
			fs.mkdirSync(path.join(odd, ".claude"));
			fs.writeFileSync(path.join(odd, ".claude", "load-ceiling"), "lots\n");
			try {
				const r = overloadReading({ load1: 30, cores: 8, env: { HOME: odd } });
				expect(r.ceiling).toBe(24);
				expect(buildOverloadText(r)).toMatch(/holds "lots", not a number/);
			} finally {
				fs.rmSync(odd, { recursive: true, force: true });
			}
		});
	});

	it("turns off at WFC_LOAD_CEILING=0", () => {
		expect(
			overloadReading({ load1: 500, cores: 8, env: { WFC_LOAD_CEILING: "0" } })
				.overloaded,
		).toBe(false);
	});

	/* A typo must not silently disarm the check. */
	it("keeps the default on an unparseable override", () => {
		expect(
			overloadReading({ load1: 0, cores: 8, env: { WFC_LOAD_CEILING: "lots" } })
				.ceiling,
		).toBe(24);
	});

	it("fails open on an unreadable load or uncountable cores", () => {
		expect(overloadReading({ load1: null, cores: 8, env: {} }).overloaded).toBe(
			false,
		);
		expect(overloadReading({ load1: 500, cores: 0, env: {} }).overloaded).toBe(
			false,
		);
	});
});

describe("sessionCeiling — how many live sessions admission lets run at once (#2141)", () => {
	it("sits at 1.5 per core, 12 on 8 cores, rounded down", () => {
		expect(sessionCeiling(8, {})).toBe(12);
		expect(sessionCeiling(3, {})).toBe(4);
	});

	it("takes WFC_SESSION_CEILING over the default, and turns off at 0", () => {
		expect(sessionCeiling(8, { WFC_SESSION_CEILING: "6" })).toBe(6);
		expect(sessionCeiling(8, { WFC_SESSION_CEILING: "0" })).toBeNull();
	});

	/* A typo must not silently disarm the check. */
	it("keeps the default on an unparseable override", () => {
		expect(sessionCeiling(8, { WFC_SESSION_CEILING: "lots" })).toBe(12);
	});

	/* Floored, it would hold every slot. */
	it("keeps the default on an override under one", () => {
		expect(sessionCeiling(8, { WFC_SESSION_CEILING: "0.5" })).toBe(12);
	});

	it("is off where the cores cannot be counted", () => {
		expect(sessionCeiling(0, {})).toBeNull();
	});
});

describe("holdForLoad, which keeps a suite out of an overloaded machine (#830)", () => {
	const hot = { overloaded: true, load1: 60, ceiling: 48 };
	const calm = { overloaded: false, load1: 3, ceiling: 48 };
	const noSleep = () => Promise.resolve();

	it("starts at once, silently, below the ceiling", async () => {
		const lines: string[] = [];
		const go = await holdForLoad({
			read: () => calm,
			sleepFn: noSleep,
			out: { write: (l: string) => lines.push(l) },
		});
		expect(go).toBe(true);
		expect(lines).toEqual([]);
	});

	it("holds while overloaded and starts once the load falls", async () => {
		const lines: string[] = [];
		const readings = [hot, hot, calm];
		const go = await holdForLoad({
			read: () => readings.shift() ?? calm,
			sleepFn: noSleep,
			out: { write: (l: string) => lines.push(l) },
		});
		expect(go).toBe(true);
		expect(readings).toHaveLength(0);
		expect(lines.join("")).toMatch(/load1 60 is at or above the 48 ceiling/);
		expect(lines.join("")).toMatch(/fell to 3/);
	});

	/* Unlike --queue's run-anyway: running into the overload risks the freeze. */
	it("refuses when the hold expires still overloaded, quoting the load1 figure", async () => {
		const lines: string[] = [];
		const go = await holdForLoad({
			read: () => hot,
			sleepFn: noSleep,
			timeoutMs: -1,
			out: { write: (l: string) => lines.push(l) },
		});
		expect(go).toBe(false);
		expect(lines.join("")).toMatch(/REFUSED — load1 still 60/);
	});
});
