import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readPartSuitePeak } from "./part-suite-ledger.js";
import { bucketOf, partKindOfRoute, partSuitePeak } from "./part-suite-peak.js";

const MIN_SAMPLES = 30;

const NOW = Date.parse("2026-11-17T12:00:00Z");
const HOUR = 60 * 60 * 1000;

type Line = Record<string, unknown>;

const line = (over: Partial<Line> & { sum?: number } = {}): Line => {
	const { sum = 400, ...rest } = over;
	return {
		kind: "named",
		wholeSlot: false,
		resolvedFiles: 1,
		startedAt: new Date(NOW - HOUR).toISOString(),
		memory: { peaksMiB: { sum } },
		...rest,
	};
};

const lines = (n: number, over: Partial<Line> = {}) =>
	Array.from({ length: n }, (_, i) => line({ sum: i + 1, ...over }));

describe("bucketOf", () => {
	it.each([
		[1, "1"],
		[2, "2-4"],
		[4, "2-4"],
		[5, "5-20"],
		[20, "5-20"],
		[21, "21-120"],
		[120, "21-120"],
	])("puts %i files in %s", (files, bucket) => {
		expect(bucketOf(files)).toBe(bucket);
	});

	it.each([0, 121, Number.NaN])("puts %s files in none", (files) => {
		expect(bucketOf(files)).toBeNull();
	});
});

describe("partSuitePeak", () => {
	const named1 = { kind: "named", files: 1, now: NOW } as const;

	it("is the nearest-rank p99 of the bucket's peaks", () => {
		expect(partSuitePeak(lines(200), named1)).toEqual({
			kind: "named",
			p99Mb: 198,
			samples: 200,
			bucket: "1",
		});
		expect(partSuitePeak(lines(30), named1)?.p99Mb).toBe(30);
	});

	it("is none under the minimum sample count", () => {
		expect(partSuitePeak(lines(MIN_SAMPLES - 1), named1)).toBeNull();
	});

	it("keeps kinds apart", () => {
		const mixed = [...lines(30), ...lines(30, { kind: "touched", sum: 9000 })];
		expect(partSuitePeak(mixed, named1)?.p99Mb).toBe(30);
		expect(
			partSuitePeak(mixed, { kind: "touched", files: 1, now: NOW })?.p99Mb,
		).toBe(9000);
	});

	it("reads only the run's own bucket", () => {
		const both = [...lines(30), ...lines(30, { resolvedFiles: 4, sum: 777 })];
		expect(partSuitePeak(both, { ...named1, files: 2 })?.p99Mb).toBe(777);
		expect(partSuitePeak(both, { ...named1, files: 5 })).toBeNull();
	});

	it("cuts the window at 7 days", () => {
		const inside = new Date(NOW - 7 * 24 * HOUR + 1000).toISOString();
		const outside = new Date(NOW - 7 * 24 * HOUR - 1000).toISOString();
		expect(
			partSuitePeak(lines(30, { startedAt: inside }), named1),
		).not.toBeNull();
		expect(partSuitePeak(lines(30, { startedAt: outside }), named1)).toBeNull();
	});

	it("leaves out lines with no memory, a whole slot or another kind", () => {
		const excluded = [
			...lines(10, { memory: null }),
			...lines(10, { wholeSlot: true }),
			...lines(10, { kind: "full" }),
		];
		expect(partSuitePeak([...lines(29), ...excluded], named1)).toBeNull();
	});

	it("counts red runs", () => {
		const red = lines(30, { verdict: "red" });
		expect(partSuitePeak(red, named1)?.samples).toBe(30);
	});
});

describe("readPartSuitePeak", () => {
	const write = (text: string) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "part-peak-"));
		const file = path.join(dir, ".test-runs.jsonl");
		fs.writeFileSync(file, text);
		return file;
	};

	it("reads the ledger's lines, a torn one skipped", () => {
		const file = write(
			`${lines(30)
				.map((l) => JSON.stringify(l))
				.join("\n")}\n{"memory":{"wholeSlot":false`,
		);
		expect(
			readPartSuitePeak({ kind: "named", files: 1 }, { file, now: NOW }),
		).toEqual({
			peak: { kind: "named", p99Mb: 30, samples: 30, bucket: "1" },
		});
	});

	it("reads an absent ledger as thin", () => {
		const file = path.join(os.tmpdir(), "no-such-dir-5366", "ledger.jsonl");
		expect(
			readPartSuitePeak({ kind: "named", files: 1 }, { file, now: NOW }),
		).toEqual({ peak: null });
	});

	it("names why a ledger would not read", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "part-peak-"));
		const got = readPartSuitePeak(
			{ kind: "named", files: 1 },
			{ file: dir, now: NOW },
		);
		expect(got).toHaveProperty("why");
	});
});

describe("partKindOfRoute", () => {
	it("tells a named or touched route, and no other, an --adopt one included", () => {
		expect(partKindOfRoute({ kind: "named", source: "named" })).toBe("named");
		expect(partKindOfRoute({ kind: "named", source: "retest" })).toBe("named");
		expect(partKindOfRoute({ kind: "touched", source: "own" })).toBe("touched");
		expect(partKindOfRoute({ kind: "named", source: "adopt" })).toBeNull();
		expect(partKindOfRoute({ kind: "changed", source: "changed" })).toBeNull();
		expect(partKindOfRoute(null)).toBeNull();
	});
});
