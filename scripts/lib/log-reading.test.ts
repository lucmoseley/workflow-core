// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isRead, readingAt, readLogs } from "./log-reading.js";

const point = { point: 1000, ceiling: 2000, fixed: true, clock: 0 };

describe("readingAt", () => {
	it("reads to now while no repo is live", () => {
		expect(readingAt(null, 500)).toEqual({
			reached: false,
			cutoff: 500,
			nowMs: 500,
		});
	});

	it("reads to now before the point", () => {
		expect(readingAt(point, 999)).toEqual({
			reached: false,
			cutoff: 999,
			nowMs: 999,
		});
	});

	it("counts the point itself as reached", () => {
		expect(readingAt(point, 1000)).toEqual({
			reached: true,
			cutoff: 1000,
			nowMs: 1000,
		});
	});

	it("reads to the point once past it", () => {
		expect(readingAt(point, 1500)).toEqual({
			reached: true,
			cutoff: 1000,
			nowMs: 1500,
		});
	});
});

describe("isRead", () => {
	const at = readingAt(point, 1500);

	it("reads an event stamped at the cutoff", () => {
		expect(isRead(at, new Date(1000).toISOString())).toBe(true);
	});

	it("leaves out an event stamped after it", () => {
		expect(isRead(at, new Date(1001).toISOString())).toBe(false);
	});
});

describe("readLogs", () => {
	it("refuses a log holding a record zeroed by a crash, naming its line (#5775)", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-reading-"));
		try {
			const file = path.join(dir, "log.jsonl");
			const row = JSON.stringify({ at: "2026-01-01T00:00:00Z" });
			fs.writeFileSync(file, `${row}\n\0\0\0${row}\n`);
			expect(() => readLogs(new Map([["repo", dir]]), () => file)).toThrow(
				`${file}:2 holds a record zeroed by a crash`,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
