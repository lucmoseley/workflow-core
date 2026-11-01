// @vitest-environment node
/*
 * lib/review-reads.js (#3765): the morning review's slow reads kept for the
 * day. Break it and a filing killed part way starts again from nothing, so
 * on a slow morning it never completes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reviewReads } from "./review-reads.js";

let dir: string;
let file: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-reads-"));
	file = path.join(dir, "reads.json");
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const ok = (v: object) => "line" in v;

describe("reviewReads (#3765)", () => {
	it("serves a kept read to a later run the same day without reading again", () => {
		let reads = 0;
		const fresh = () => {
			reads++;
			return { line: "12 primitives" };
		};
		expect(reviewReads("2026-11-01", file).read("count a", fresh, ok)).toEqual({
			line: "12 primitives",
		});
		expect(reviewReads("2026-11-01", file).read("count a", fresh, ok)).toEqual({
			line: "12 primitives",
		});
		expect(reads).toBe(1);
	});

	it("keeps no failed read, so the next run retries it", () => {
		let reads = 0;
		const failing = () => {
			reads++;
			return { why: "timed out" };
		};
		reviewReads("2026-11-01", file).read("count a", failing, ok);
		reviewReads("2026-11-01", file).read("count a", failing, ok);
		expect(reads).toBe(2);
	});

	it("reads afresh on another day, and over a damaged file", () => {
		reviewReads("2026-11-01", file).read("k", () => ({ line: "old" }), ok);
		expect(
			reviewReads("2026-11-02", file).read("k", () => ({ line: "new" }), ok),
		).toEqual({ line: "new" });
		fs.writeFileSync(file, "{ torn");
		expect(
			reviewReads("2026-11-02", file).read("k", () => ({ line: "again" }), ok),
		).toEqual({ line: "again" });
	});
});
