// @vitest-environment node
/*
 * lib/row-measure.js (#5029): the row counts the read-audit measurement
 * prints, against a hand count on seeded stores and markers, and the
 * kept-run hand-off between the tree watch and the measurement. A wrong
 * count here misreports what a read-audit change costs the pass store.
 *
 * The judge is crossed with a stand-in reader, whose pass store writes the
 * lines a case seeds: the real reader needs a whole audited suite run.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const {
	KEEP_ENV,
	batchesOf,
	buildJudge,
	keepRun,
	movedSince,
	namedRunWeights,
	readKept,
	readOptions,
	runKey,
	summarise,
} = require("./row-measure.js");
const { readTreeSnapshot } = require("./tree-drift.js");

let tmp = "";
beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "row-measure-")));
});
afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

/** A sink for what a call says, where the case does not read it. */
const quiet = { write: () => true };

const line = (...rows: object[]) =>
	JSON.stringify({ format: 18, at: "x", sha: "y", tree: null, files: rows });

/* A stand-in reader: its audit reads `audits.json` from the log directory,
 * and its pass store writes the run's `shards`, each a path under the store
 * and its lines, and says which run it recorded. */
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
	for (const [rel, lines] of Object.entries(run.shards)) {
		fs.mkdirSync(path.dirname(path.join(storeRoot, rel)), { recursive: true });
		fs.appendFileSync(path.join(storeRoot, rel), lines.map((l) => l + "\\n").join(""));
	}
	err.write("recorded " + run.sha + "\\n");
};`,
	);
	return lib;
}

function keptBatch(
	name: string,
	audits: object,
	shards: Record<string, string[]>,
) {
	const dir = path.join(tmp, name);
	fs.mkdirSync(dir);
	fs.writeFileSync(path.join(dir, "audits.json"), JSON.stringify(audits));
	return { dir, run: { sha: name, root: tmp, shards, keptMark: null } };
}

describe("buildJudge", () => {
	it("caches a file whose shard holds a keyed pass, anywhere in the store, and no fail, voiding row or bad line", () => {
		const judge = buildJudge(fakeReader());
		judge.add(
			keptBatch(
				"one",
				{},
				{
					"a.jsonl": [line({ file: "a", outcome: "pass", inputs: {} })],
					"b.jsonl": [
						line({ file: "b", outcome: "fail", voiding: true, inputs: {} }),
					],
					"c.jsonl": [
						"{not json",
						"",
						line({ file: "c", outcome: "fail", inputs: {} }),
					],
					"e.jsonl": [
						line({ file: "e", outcome: "pass", voiding: true }),
						line({ file: "e", outcome: "pass", inputs: {} }),
					],
					"f.jsonl": [JSON.stringify({ format: 18, files: "none" })],
					"other/layout/g.jsonl": [line({ file: "g", outcome: "pass" })],
				},
			),
		);
		// Hand count: a, e and g hold a keyed pass; b a voiding row, c a fail, f none.
		expect([...judge.read().rows].sort()).toEqual(["a", "e", "g"]);
		judge.dispose();
	});

	it("records every kept batch through the reader's pass store, off its audit's reads", () => {
		const judge = buildJudge(fakeReader());
		judge.add(
			keptBatch(
				"one",
				{ a: { reads: {} }, b: { doubt: "a child left no log" } },
				{ "a.jsonl": [line({ file: "a", outcome: "pass" })] },
			),
		);
		judge.add(
			keptBatch(
				"two",
				{ c: { reads: {} } },
				{ "c.jsonl": [line({ file: "c", outcome: "pass" })] },
			),
		);
		const got = judge.read();
		expect([...got.rows].sort()).toEqual(["a", "c"]);
		expect([...got.audited].sort()).toEqual(["a", "b", "c"]);
		expect(Object.fromEntries(got.doubts)).toEqual({
			b: "a child left no log",
		});
		expect(got.said).toEqual(["recorded one\n", "recorded two\n"]);
		judge.dispose();
	});
});

describe("namedRunWeights", () => {
	it("weights each sample file by the named runs in the window that selected it, the measurement's own aside", () => {
		const since = Date.parse("2026-11-12T00:00:00Z") - 14 * 864e5;
		const named = { scope: { fileFilters: ["x"] } };
		const ownRun = { ...named, sha: "s", at: "2026-11-11T05:00:00Z" };
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
			{ ...ownRun, selected: ["a", "b", "c"] },
			null,
		];
		const { weights, runs } = namedRunWeights(
			markers,
			["a", "b", "c"],
			since,
			new Set([runKey(ownRun)]),
		);
		// Hand count: the first and fifth markers are named, dated in the window and not the measurement's.
		expect(runs).toBe(2);
		expect(Object.fromEntries(weights)).toEqual({ a: 2, b: 1, c: 0 });
	});
});

describe("summarise", () => {
	it("prints each reader's caching rows and weighted share, and each file lost or gained with its doubt", () => {
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
			said: [],
		};
		const ours = {
			name: "after",
			rows: new Set(["a", "c"]),
			audited: new Set(["a", "b", "c"]),
			doubts: new Map([["b", "a child left no log"]]),
			said: [],
		};
		const out = summarise({ sample, weights, runs: 7, against, ours });
		expect(out).toContain("| before | 3/4 | 100.0% (10/10) |");
		expect(out).toContain("| after | 2/4 | 30.0% (3/10) |");
		expect(out).toContain("Lost (2), with after's doubt:");
		expect(out).toContain("- b (weight 1): a child left no log");
		expect(out).toContain("- d (weight 6): not audited");
		expect(out).toContain(
			"- c (weight 0): no audit doubt: the pass store cached no row on its inputs",
		);
		expect(out[0]).toBe(
			"Sample: 4 files, 3 audited. Named runs over 14 days: 7 (10 file-runs on the sample).",
		);
	});
});

const recordedRun = (
	root: string,
	after: object = { head: "h", files: {} },
) => ({
	sha: "s",
	at: "2026-11-12T00:00:00Z",
	tree: null,
	root,
	files: [{ file: "a.test.ts", outcome: "pass", imports: [] }],
	shared: [],
	clean: true,
	drifted: [],
	after,
	startMark: BigInt("123456789012345678901"),
});

function logDir() {
	const dir = path.join(tmp, "wfc-read-audit-x");
	fs.mkdirSync(dir);
	fs.writeFileSync(path.join(dir, "owner.1.jsonl"), '{"k":"claim"}\n');
	return dir;
}

describe("keepRun and readKept", () => {
	it("keeps the logs and the run, its marks whole, where the switch names a directory", () => {
		const root = path.join(tmp, "checkout");
		const keep = path.join(tmp, "keep");
		fs.mkdirSync(root);
		fs.mkdirSync(keep);
		keepRun(logDir(), recordedRun(root), {
			env: { [KEEP_ENV]: keep },
			err: quiet,
		});
		const [kept] = readKept(keep);
		const { keptMark, ...run } = kept.run;
		expect(run).toEqual(recordedRun(root));
		expect(typeof keptMark).toBe("bigint");
		expect(fs.readFileSync(path.join(kept.dir, "owner.1.jsonl"), "utf8")).toBe(
			'{"k":"claim"}\n',
		);
	});

	it("keeps nothing without the switch, or with no run to keep", () => {
		const keep = path.join(tmp, "keep");
		fs.mkdirSync(keep);
		const dir = logDir();
		keepRun(dir, recordedRun(tmp), { env: {}, err: quiet });
		keepRun(dir, null, { env: { [KEEP_ENV]: keep }, err: quiet });
		expect(readKept(keep)).toEqual([]);
	});

	it("refuses a directory in the checkout, which would hand every child a checkout path", () => {
		const keep = path.join(tmp, "keep");
		fs.mkdirSync(keep);
		const said: string[] = [];
		keepRun(logDir(), recordedRun(tmp), {
			env: { [KEEP_ENV]: keep },
			err: { write: (s: string) => said.push(s) },
		});
		expect(readKept(keep)).toEqual([]);
		expect(said.join("")).toMatch(/names a directory in the checkout/);
	});
});

describe("movedSince", () => {
	function keptRepo() {
		const repo = path.join(tmp, "repo");
		const keep = path.join(tmp, "keep");
		fs.mkdirSync(repo);
		fs.mkdirSync(keep);
		const git = (...args: string[]) =>
			execFileSync(
				"git",
				["-c", "user.name=t", "-c", "user.email=t@t", ...args],
				{
					cwd: repo,
					stdio: "ignore",
				},
			);
		git("init", "-q");
		fs.writeFileSync(path.join(repo, "x.txt"), "x\n");
		git("add", "x.txt");
		git("commit", "-qm", "x");
		keepRun(logDir(), recordedRun(repo, readTreeSnapshot(repo)), {
			env: { [KEEP_ENV]: keep },
			err: quiet,
		});
		return { repo, run: readKept(keep)[0].run };
	}

	it("says nothing of a tree that stands as the run was kept", () => {
		expect(movedSince(keptRepo().run)).toBeNull();
	});

	it("names a tracked file only touched since the run was kept, which drops its rows unsaid", () => {
		const { repo, run } = keptRepo();
		const now = new Date();
		fs.utimesSync(path.join(repo, "x.txt"), now, now);
		expect(movedSince(run)).toEqual(["x.txt"]);
	});

	it("names a tracked file rewritten since", () => {
		const { repo, run } = keptRepo();
		fs.writeFileSync(path.join(repo, "x.txt"), "y\n");
		expect(movedSince(run)).toEqual(["x.txt"]);
	});
});

describe("readOptions", () => {
	it("refuses a missing --against and a batch size that is no whole number above 0", () => {
		expect(readOptions({}, 120)).toEqual({ refusal: "--against is required" });
		for (const n of ["0", "1.5", "x"])
			expect(
				readOptions({ "--against": "HEAD", "--batch-files": n }, 120),
			).toEqual({
				refusal: "--batch-files takes a whole number above 0",
			});
	});

	it("reads the flags given and the default batch size", () => {
		expect(readOptions({ "--against": "HEAD" }, 120)).toEqual({
			against: "HEAD",
			logs: null,
			keep: false,
			max: 120,
		});
		expect(
			readOptions(
				{
					"--against": "d",
					"--logs": "l",
					"--keep": true,
					"--batch-files": "7",
				},
				120,
			),
		).toEqual({ against: "d", logs: "l", keep: true, max: 7 });
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
