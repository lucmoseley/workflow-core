// @vitest-environment node
/*
 * Pins what pick-next lays out for the skill's §4 band read (#4329): the
 * grep prediction stored for each write-set cache miss (mantahostels#1001),
 * each open issue's body on disk with its cache key (mantahostels#409,
 * mantahostels#385), and whether the run needs a band read at all
 * (mantahostels#1485).
 *
 * Loosen a case and a run dispatches a ~60 s band-read subagent it did not
 * need, reads a grep back as an agent's judgement, or leaves a band read
 * unable to store its answer.
 *
 * The store and the dump are real files under each case's own temp
 * directory; the cache lookup and the conflict graph are seeded.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const {
	bandReadRequiredOf,
	dumpBodies,
	prewarm,
} = require("./pick-next-band-read.js");
const writeSetCache = require("./write-set-cache.js");

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pick-next-band-read-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const tracked = { ok: true, files: ["scripts/a.js"] };
const issue = (number: number, body: string, labels: string[] = []) => ({
	number,
	title: `issue ${number}`,
	body,
	labels,
});
const miss = (number: number, body: string) => ({
	number,
	state: "cold",
	bodyHash: writeSetCache.bodyHash(body),
	gonePaths: null,
});

describe("the prediction stored over each miss (mantahostels#1001)", () => {
	it("leaves nothing to derive on a first run, so no band read is dispatched", () => {
		const frontier = [issue(1, "one"), issue(2, "two")];
		const r = prewarm(dir, frontier, {
			tracked,
			split: { warm: [], cold: [miss(1, "one"), miss(2, "two")] },
			enabled: true,
		});
		expect(r.warm).toEqual([]);
		expect(r.cold).toEqual([]);
		expect(
			r.provisional.map((p: { number: number; replaced: string }) => [
				p.number,
				p.replaced,
			]),
		).toEqual([
			[1, "cold"],
			[2, "cold"],
		]);
	});

	it("reads its own prediction back as provisional on the next run, never as warm", () => {
		const carried = {
			number: 1,
			writeSet: [],
			provisional: true,
			unrevalidated: false,
		};
		const r = prewarm(dir, [issue(1, "one")], {
			tracked,
			split: { warm: [carried], cold: [] },
			enabled: true,
		});
		expect(r.warm).toEqual([]);
		// Carried in from the store rather than written over a miss this run.
		expect(r.provisional).toEqual([carried]);
	});

	it("leaves a wayfinder:map issue cold, and says why", () => {
		const body = "`scripts/a.js`";
		const r = prewarm(dir, [issue(1, body, ["wayfinder:map"])], {
			tracked,
			split: { warm: [], cold: [miss(1, body)] },
			enabled: true,
		});
		expect(r.cold.map((c: { number: number }) => c.number)).toEqual([1]);
		expect(r.skipped).toEqual([
			{ number: 1, why: expect.stringMatching(/wayfinder:map/) },
		]);
	});
});

describe("the bodies dumped for a band read (mantahostels#409)", () => {
	it("names the issue in the file, so a band read needs no second lookup", () => {
		const out = path.join(dir, "bodies");
		const r = dumpBodies(out, [{ number: 7, title: "a title", body: "text" }]);
		expect(r).toEqual({ ok: true, dir: out, count: 1 });
		const f = fs.readFileSync(path.join(out, "7.md"), "utf8");
		expect(f).toMatch(/#7 — a title/);
		expect(f).toContain("text");
	});

	it("writes the key into each dumped body, so a band read needs no lookup (mantahostels#385)", () => {
		const out = path.join(dir, "bodies");
		dumpBodies(out, [{ number: 1, title: "t", body: "one" }]);
		expect(fs.readFileSync(path.join(out, "1.md"), "utf8")).toContain(
			`<!-- body-hash: ${miss(1, "one").bodyHash} -->`,
		);
	});
});

describe("whether the run needs a band read (mantahostels#1485)", () => {
	it("is true on a cold entry alone, even with nothing nominated", () => {
		expect(
			bandReadRequiredOf({ nominated: [] }, { cold: [miss(1, "x")] }),
		).toBe(true);
	});

	it("is true where the nomination list is non-empty", () => {
		expect(bandReadRequiredOf({ nominated: [1] }, { cold: [] })).toBe(true);
	});

	it("stays false with nothing nominated and nothing cold", () => {
		expect(bandReadRequiredOf({ nominated: [] }, { cold: [] })).toBe(false);
	});
});
