// @vitest-environment node
/*
 * test-file-timings.js records each test file's span from queued to end and
 * writes it once at the run's end, for run-vitest.js's run-cost report
 * (#1883). The clock is handed in, so every figure here is exact (§X9).
 *
 * Loosen a case and the report names a file at the wrong seconds, reads a
 * previous run's figures as this one's, or loses its record unannounced.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { clear, createTimings } = require("./test-file-timings.js");

/* test-file-timings.js's SLOWEST_KEPT. */
const SLOWEST_KEPT = 10;

let dir: string;
let file: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-timings-"));
	file = path.join(dir, "timings.json");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const readSaved = () => JSON.parse(fs.readFileSync(file, "utf8"));

function sink() {
	const said: string[] = [];
	return { said, write: (s: string) => said.push(s) };
}

describe("the span", () => {
	it("is queued to end, in seconds", () => {
		const timings = createTimings();
		timings.start("/r/a.test.ts", 1000);
		timings.end("/r/a.test.ts", 13_500);
		timings.save(file);
		expect(readSaved()).toEqual({ "/r/a.test.ts": 12.5 });
	});

	it("keeps no module that never ended, and no end that was never queued", () => {
		const timings = createTimings();
		timings.start("/r/parked.test.ts", 0);
		timings.end("/r/never-queued.test.ts", 5000);
		timings.save(file);
		expect(readSaved()).toEqual({});
	});

	it("ignores a module with no id", () => {
		const timings = createTimings();
		timings.start(undefined, 0);
		timings.end(undefined, 5000);
		timings.save(file);
		expect(readSaved()).toEqual({});
	});
});

describe("the slowest files", () => {
	it("are the ended modules slowest first, cut to SLOWEST_KEPT", () => {
		const timings = createTimings();
		for (let i = 0; i <= SLOWEST_KEPT; i++) {
			timings.start(`/r/f${i}.test.ts`, 0);
			timings.end(`/r/f${i}.test.ts`, (i + 1) * 1000);
		}
		timings.start("/r/parked.test.ts", 0);
		const slowest = timings.slowest();
		expect(slowest).toHaveLength(SLOWEST_KEPT);
		expect(slowest[0]).toEqual({
			file: `/r/f${SLOWEST_KEPT}.test.ts`,
			seconds: SLOWEST_KEPT + 1,
		});
		expect(slowest.map((s: { file: string }) => s.file)).not.toContain(
			"/r/f0.test.ts",
		);
	});
});

describe("a new run", () => {
	it("starts empty, so a previous run's figures are never read as this one's", () => {
		const previous = createTimings();
		previous.start("/r/old.test.ts", 0);
		previous.end("/r/old.test.ts", 1000);
		createTimings().save(file);
		expect(readSaved()).toEqual({});
	});
});

describe("the record on disk", () => {
	it("is not written where no file is named", () => {
		const timings = createTimings();
		timings.start("/r/a.test.ts", 0);
		timings.end("/r/a.test.ts", 1000);
		timings.save(undefined);
		expect(fs.readdirSync(dir)).toEqual([]);
	});

	it("names a record it cannot write in one line, and never throws", () => {
		const err = sink();
		const missing = path.join(dir, "missing", "timings.json");
		expect(() => createTimings(err).save(missing)).not.toThrow();
		expect(err.said).toHaveLength(1);
		expect(err.said[0]).toContain(missing);
	});

	it("is removed by clear, and clearing an absent one says nothing", () => {
		const err = sink();
		createTimings().save(file);
		clear(file, err);
		expect(fs.existsSync(file)).toBe(false);
		clear(file, err);
		expect(err.said).toEqual([]);
	});
});
