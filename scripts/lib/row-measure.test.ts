// @vitest-environment node
/*
 * lib/row-measure.js (#5029): the row counts the read-audit measurement
 * prints, checked against a hand count on seeded stores and markers, and the
 * kept-run hand-off between the tree watch and the measurement.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const {
	KEEP_ENV,
	batchesOf,
	judge,
	keepRun,
	keptRows,
	namedRunWeights,
	readKept,
	summarise,
} = require("./row-measure.js");

let tmp = "";
beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "row-measure-")));
});
afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

/** A sink for what a call says, where the case does not read it. */
const quiet = { write: () => true };

const resultsDir = (storeRoot: string) =>
	path.join(storeRoot, ".claude", "tmp", "markers", ".test-file-results");

/** A shard per entry, each line a run line holding `rows`. */
function seedStore(storeRoot: string, shards: Record<string, string[]>) {
	fs.mkdirSync(resultsDir(storeRoot), { recursive: true });
	for (const [name, lines] of Object.entries(shards))
		fs.writeFileSync(
			path.join(resultsDir(storeRoot), name),
			lines.map((l) => `${l}\n`).join(""),
		);
}

const line = (...rows: object[]) =>
	JSON.stringify({ format: 18, at: "x", sha: "y", tree: null, files: rows });

describe("keptRows", () => {
	it("counts a file with a keyed row, pass or fail, and no voiding row, blank line or bad line", () => {
		seedStore(tmp, {
			"a.jsonl": [line({ file: "a.test.ts", outcome: "pass", inputs: {} })],
			"b.jsonl": [
				line({ file: "b.test.ts", outcome: "fail", voiding: true, inputs: {} }),
			],
			"c.jsonl": [
				"{not json",
				"",
				line({ file: "c.test.ts", outcome: "fail", inputs: {} }),
			],
			"d.jsonl": [],
			"e.jsonl": [
				line({ file: "e.test.ts", outcome: "pass", voiding: true }),
				line({ file: "e.test.ts", outcome: "pass", inputs: {} }),
			],
			"f.jsonl": [JSON.stringify({ format: 18, files: "none" })],
		});
		// Hand count: a, c and e hold a keyed row; b only a voiding one; d and f none.
		expect([...keptRows(tmp)].sort()).toEqual([
			"a.test.ts",
			"c.test.ts",
			"e.test.ts",
		]);
	});

	it("is empty where no store was written", () => {
		expect(keptRows(tmp).size).toBe(0);
	});
});

describe("namedRunWeights", () => {
	it("weights each sample file by the named runs in the window that selected it", () => {
		const now = Date.parse("2026-11-12T00:00:00Z");
		const since = now - 14 * 864e5;
		const named = { scope: { fileFilters: ["x"] } };
		const markers = [
			{ ...named, at: "2026-11-11T00:00:00Z", selected: ["a", "b"] },
			{ ...named, at: "2026-10-01T00:00:00Z", selected: ["a"] },
			{
				scope: { fileFilters: [] },
				at: "2026-11-11T00:00:00Z",
				selected: ["a"],
			},
			{ at: "2026-11-11T00:00:00Z", selected: ["a"] },
			{ ...named, startedAt: "2026-11-10T00:00:00Z", selected: ["a", "z"] },
			{ ...named, selected: ["a"] },
		];
		const { weights, runs } = namedRunWeights(markers, ["a", "b", "c"], since);
		// Hand count: the first and fifth markers are named and in the window.
		expect(runs).toBe(2);
		expect(Object.fromEntries(weights)).toEqual({ a: 2, b: 1, c: 0 });
	});
});

describe("summarise", () => {
	it("prints each reader's rows and weighted share, and each file lost or gained with its doubt", () => {
		const sample = ["a", "b", "c", "d"];
		const weights = new Map([
			["a", 3],
			["b", 1],
			["c", 0],
			["d", 6],
		]);
		const against = {
			name: "before",
			rows: new Set(["a", "b", "d"]),
			audited: new Set(sample),
			doubts: new Map(),
		};
		const ours = {
			name: "after",
			rows: new Set(["a", "c"]),
			audited: new Set(["a", "b", "c"]),
			doubts: new Map([["b", "a child left no log"]]),
		};
		const out = summarise({ sample, weights, runs: 7, against, ours });
		expect(out).toContain("| before | 3/4 | 100.0% (10/10) |");
		expect(out).toContain("| after | 2/4 | 30.0% (3/10) |");
		expect(out).toContain("- b (weight 1): a child left no log");
		expect(out).toContain("- d (weight 6): not audited");
		expect(out).toContain("Lost (2), with after's doubt:");
		expect(out).toContain(
			"- c (weight 0): no audit doubt: the pass store kept no row on its inputs",
		);
		expect(out[0]).toBe(
			"Sample: 4 files, 3 audited. Named runs over 14 days: 7 (10 file-runs on the sample).",
		);
	});
});

describe("keepRun and readKept", () => {
	const run = (root: string) => ({
		sha: "s",
		at: "2026-11-12T00:00:00Z",
		tree: null,
		root,
		files: [{ file: "a.test.ts", outcome: "pass", imports: [] }],
		shared: [],
		clean: true,
		drifted: [],
		after: { head: "h", files: {} },
		startMark: BigInt("123456789012345678901"),
	});

	function logDir() {
		const dir = path.join(tmp, "wfc-read-audit-x");
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "owner.1.jsonl"), '{"k":"claim"}\n');
		return dir;
	}

	it("keeps the logs and the run, its start mark whole, where the switch names a directory", () => {
		const root = path.join(tmp, "checkout");
		const keep = path.join(tmp, "keep");
		fs.mkdirSync(root);
		fs.mkdirSync(keep);
		const dir = logDir();
		keepRun(dir, run(root), { env: { [KEEP_ENV]: keep }, err: quiet });
		const [kept] = readKept(keep);
		expect(kept.run).toEqual(run(root));
		expect(fs.readFileSync(path.join(kept.dir, "owner.1.jsonl"), "utf8")).toBe(
			'{"k":"claim"}\n',
		);
	});

	it("keeps nothing without the switch, or with no run to keep", () => {
		const keep = path.join(tmp, "keep");
		fs.mkdirSync(keep);
		const dir = logDir();
		keepRun(dir, run(tmp), { env: {}, err: quiet });
		keepRun(dir, null, { env: { [KEEP_ENV]: keep }, err: quiet });
		expect(readKept(keep)).toEqual([]);
	});

	it("refuses a directory in the checkout, which would hand every child a checkout path", () => {
		const keep = path.join(tmp, "keep");
		fs.mkdirSync(keep);
		const said: string[] = [];
		keepRun(logDir(), run(tmp), {
			env: { [KEEP_ENV]: keep },
			err: { write: (s: string) => said.push(s) },
		});
		expect(readKept(keep)).toEqual([]);
		expect(said.join("")).toMatch(/names a directory in the checkout/);
	});
});

describe("judge", () => {
	/* A stand-in reader: its audit reads `audits.json` from the log
	 * directory, and its pass store keys every audited file it does not
	 * doubt, as a row-recording reader would. */
	function fakeReader() {
		const lib = path.join(tmp, "reader", "scripts", "lib");
		fs.mkdirSync(lib, { recursive: true });
		fs.writeFileSync(
			path.join(lib, "read-audit.js"),
			`const fs = require("node:fs"), path = require("node:path");
module.exports.readAudits = (dir) => new Map(Object.entries(JSON.parse(fs.readFileSync(path.join(dir, "audits.json"), "utf8"))));`,
		);
		fs.writeFileSync(
			path.join(lib, "pass-store.js"),
			`const fs = require("node:fs"), path = require("node:path");
module.exports.record = (run, { storeRoot, err }) => {
	const dir = path.join(storeRoot, ".claude", "tmp", "markers", ".test-file-results");
	fs.mkdirSync(dir, { recursive: true });
	for (const f of run.files) {
		const a = run.audits.get(f.file);
		const voiding = !a || "doubt" in a;
		fs.appendFileSync(path.join(dir, f.file.replace(/\\W/g, "_") + ".jsonl"), JSON.stringify({ files: [{ file: f.file, voiding }] }) + "\\n");
	}
	err.write("recorded " + run.sha + "\\n");
};`,
		);
		return lib;
	}

	function keptBatch(name: string, audits: object, files: string[]) {
		const dir = path.join(tmp, name);
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "audits.json"), JSON.stringify(audits));
		return {
			dir,
			run: {
				sha: name,
				root: tmp,
				files: files.map((file) => ({ file, outcome: "pass", imports: [] })),
			},
		};
	}

	it("records every kept batch through the reader's pass store, off its audit's reads", () => {
		const kept = [
			keptBatch(
				"one",
				{ a: { reads: {} }, b: { doubt: "a child left no log" } },
				["a", "b"],
			),
			keptBatch("two", { c: { reads: {} } }, ["c", "d"]),
		];
		const got = judge(fakeReader(), kept);
		// Hand count: a and c keyed; b doubted; d never audited.
		expect([...got.rows].sort()).toEqual(["a", "c"]);
		expect([...got.audited].sort()).toEqual(["a", "b", "c"]);
		expect(Object.fromEntries(got.doubts)).toEqual({
			b: "a child left no log",
		});
		expect(got.said).toEqual(["recorded one\n", "recorded two\n"]);
	});
});

describe("batchesOf", () => {
	it("cuts the sample into the fewest near-equal batches under the bound", () => {
		const files = Array.from({ length: 338 }, (_, i) => String(i));
		expect(batchesOf(files, 120).map((b: string[]) => b.length)).toEqual([
			113, 113, 112,
		]);
		expect(batchesOf(files.slice(0, 5), 120)).toEqual([files.slice(0, 5)]);
	});
});
