// @vitest-environment node
/*
 * lib/review-reads.js (#3765): the morning review's slow reads kept for the
 * day. Break it and a filing killed part way starts again from nothing, so
 * on a slow morning it never completes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshReads, reviewReads } from "./review-reads.js";

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

	describe("what a read of the file prints (#3814)", () => {
		// The whole text taken: a 0-byte answer holds writeFd for its 10 s ceiling.
		const spyWrites = () =>
			vi
				.spyOn(fs, "writeSync")
				.mockImplementation((_fd, data) => Buffer.byteLength(data as string));

		afterEach(() => vi.restoreAllMocks());

		it.each([
			["torn", "{ torn"],
			["holding several lines", "x\ny\n"],
		])(
			"prints one line to stderr over a file %s, and the run carries on",
			(_name, damaged) => {
				fs.writeFileSync(file, damaged);
				const write = spyWrites();
				const reads = reviewReads("2026-11-02", file);
				const printed = write.mock.calls.map(([fd, text]) => [
					fd,
					String(text),
				]);
				write.mockRestore();
				expect(printed).toEqual([
					[2, expect.stringMatching(/ is damaged \(.*\n$/)],
				]);
				expect(String(printed[0]?.[1]).split("\n")).toHaveLength(2);
				expect(reads.read("k", () => ({ line: "fresh" }), ok)).toEqual({
					line: "fresh",
				});
			},
		);

		it("prints nothing where the file is absent", () => {
			const write = spyWrites();
			reviewReads("2026-11-02", file);
			expect(write).not.toHaveBeenCalled();
		});
	});

	it("freshReads runs every read and keeps none (#3813)", () => {
		let reads = 0;
		const fresh = () => ++reads;
		const dry = freshReads();
		expect(dry.read("k", fresh)).toBe(1);
		expect(dry.read("k", fresh)).toBe(2);
		expect(fs.readdirSync(dir)).toEqual([]);
	});
});
