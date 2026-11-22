// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
	decide,
	GATE_MINUTES,
	holdStep,
	isGateReset,
	isPreconditionMinute,
	newestResetOf,
	parseReading,
	workersFor,
} from "./away-load.js";

const AWAY_S = 900;
const NOW = 1_800_000_000;
const reading = (
	idleS: number | null,
	availMb = 1500,
	ageS = 10,
	commitPct = 60,
) => ({
	at: NOW - ageS,
	availMb,
	commitPct,
	idleS,
});
const base = {
	now: NOW,
	running: false,
	handUntil: null,
	gateCount: 0,
	done: null,
};

describe("decide", () => {
	it("starts after 15 minutes with no input, and not before", () => {
		expect(decide({ ...base, reading: reading(AWAY_S) }).kind).toBe("start");
		expect(decide({ ...base, reading: reading(AWAY_S - 1) }).kind).toBe("none");
	});

	it("never starts on a reading older than memwatch's bound, or with no input time", () => {
		expect(decide({ ...base, reading: reading(5000, 1500, 121) }).kind).toBe(
			"none",
		);
		expect(decide({ ...base, reading: reading(null) }).kind).toBe("none");
	});

	it("stops on input, on a reading past 75 s, and on no input time", () => {
		const running = { ...base, running: true };
		expect(decide({ ...running, reading: reading(30) })).toMatchObject({
			kind: "stop",
			why: expect.stringContaining("input"),
		});
		expect(decide({ ...running, reading: reading(5000, 1500, 76) }).kind).toBe(
			"stop",
		);
		expect(decide({ ...running, reading: reading(5000, 1500, 75) }).kind).toBe(
			"none",
		);
		expect(decide({ ...running, reading: null }).kind).toBe("stop");
		expect(decide({ ...running, reading: reading(null) }).kind).toBe("stop");
	});

	it("runs through input during a hand start, then by the usual rules", () => {
		const hand = { ...base, handUntil: NOW + 60 };
		expect(decide({ ...hand, reading: reading(0) }).kind).toBe("start");
		expect(decide({ ...hand, running: true, reading: reading(0) }).kind).toBe(
			"none",
		);
		expect(
			decide({
				...base,
				handUntil: NOW - 1,
				running: true,
				reading: reading(0),
			}).kind,
		).toBe("stop");
	});

	it("ends for good at the gate's count, and stays ended", () => {
		const met = decide({
			...base,
			running: true,
			gateCount: GATE_MINUTES,
			reading: reading(5000),
		});
		expect(met.kind).toBe("finish");
		expect(decide({ ...base, done: "met", reading: reading(5000) }).kind).toBe(
			"none",
		);
		expect(
			decide({ ...base, running: true, done: "met", reading: reading(5000) })
				.kind,
		).toBe("stop");
	});
});

describe("holdStep", () => {
	it("adds the excess over the band's aim in holders of 128 MB at most", () => {
		expect(holdStep(reading(5000, 1500), [])).toEqual({
			add: [128, 128, 128, 128, 128, 64],
		});
	});

	it("does nothing inside the band", () => {
		expect(holdStep(reading(5000, 800), [{ mb: 64 }])).toBeNull();
		expect(holdStep(reading(5000, 890), [{ mb: 64 }])).toBeNull();
	});

	it("drops the newest holders under the band until about the shortfall is freed", () => {
		const held = [{ mb: 128 }, { mb: 128 }, { mb: 128 }, { mb: 128 }];
		const step = holdStep(reading(5000, 700), held);
		expect(step).toEqual({ drop: [held[3]] });
		expect(holdStep(reading(5000, 600), held)).toEqual({
			drop: [held[3], held[2]],
		});
		expect(holdStep(reading(5000, 700), [])).toBeNull();
	});

	it("adds nothing past the commit line or the total bound", () => {
		expect(holdStep(reading(5000, 1500, 10, 85), [])).toBeNull();
		expect(holdStep(reading(5000, 1500), [{ mb: 7980 }])).toBeNull();
		expect(holdStep(reading(5000, 1500), [{ mb: 7800 }])).toEqual({
			add: [128, 64],
		});
	});
});

describe("workersFor", () => {
	const minute = (busyPct: number | null, load1: number | null = 8) => ({
		ts: "t",
		busyPct,
		load1,
	});
	it("adds workers under 580% busy, up to seven", () => {
		expect(workersFor(minute(300), 0)).toBe(4);
		expect(workersFor(minute(100), 5)).toBe(7);
	});
	it("holds between 580% and 720%, and sheds one over it", () => {
		expect(workersFor(minute(650), 3)).toBe(3);
		expect(workersFor(minute(760), 3)).toBe(2);
	});
	it("sheds one at load1 20, clear of the load ceiling", () => {
		expect(workersFor(minute(300, 20), 3)).toBe(2);
	});
	it("leaves the count on a minute with no CPU delta", () => {
		expect(workersFor(minute(null), 3)).toBe(3);
	});
});

describe("readings", () => {
	it("reads memwatch's raw Windows reading, idle seconds last, -1 as none", () => {
		expect(
			parseReading(
				"1795258321 2315 207247550 121285203 19141615616 30715088896 42\n",
			),
		).toEqual({ at: 1_795_258_321, availMb: 2315, commitPct: 62, idleS: 42 });
		expect(parseReading("1795258321 2315 1 2 3 4 -1")?.idleS).toBeNull();
		expect(parseReading("1795258321 2315 1 2 3 4")).toBeNull();
		expect(parseReading("")).toBeNull();
	});

	it("counts a minute by #5346's own check, a 0 read as missing", () => {
		const row = {
			ts: "2026-11-21T19:00:00+0800",
			cpu_busy_pct: 550,
			win_avail_mb: 899,
		};
		expect(isPreconditionMinute(row)).toBe(true);
		expect(isPreconditionMinute({ ...row, win_avail_mb: 900 })).toBe(false);
		expect(isPreconditionMinute({ ...row, win_avail_mb: 0 })).toBe(false);
		expect(isPreconditionMinute({ ...row, cpu_busy_pct: null })).toBe(false);
		expect(isPreconditionMinute({ ...row, win_avail_mb: null })).toBe(false);
		expect(
			isPreconditionMinute({ ...row, ts: "2026-11-11T17:26:59+0800" }),
		).toBe(false);
	});

	it("reads the newest Kernel-Power 41, and only a later one meets the gate", () => {
		const text =
			"Event[0]:\n  Log Name: System\n  Date: 2026-11-11T17:26:26.4670000Z\n";
		expect(newestResetOf(text)).toBe("2026-11-11T17:26:26");
		expect(newestResetOf("No events")).toBeNull();
		expect(isGateReset("2026-11-11T17:26:26")).toBe(false);
		expect(isGateReset("2026-11-22T03:00:00")).toBe(true);
	});
});
