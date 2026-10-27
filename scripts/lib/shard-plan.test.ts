// @vitest-environment node
/*
 * lib/shard-plan.js, and the sequencer that hands it vitest's files (#2413).
 *
 * Loosen it and a sharded Actions run drops a file or runs one twice, since
 * each shard job computes the plan alone; or puts the heavy files back on one
 * shard, whose job then overruns the 3 min verdict.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TestSpecification, Vitest } from "vitest/node";
import ShardSequencer from "../vitest-shard-sequencer";
import { heaviestFirst, planShard, secondsByFile } from "./shard-plan.js";

const seconds = (pairs: [string, number][]) => new Map(pairs);

describe("planShard", () => {
	const files = ["a", "b", "c", "d", "e", "f"];
	const timed = seconds([
		["a", 100],
		["b", 60],
		["c", 50],
		["d", 40],
		["e", 10],
		["f", 10],
	]);
	const plan = (count: number) =>
		Array.from({ length: count }, (_, k) =>
			planShard(files, timed, k + 1, count),
		);

	it("gives every file to exactly one shard", () => {
		for (const count of [1, 2, 3, 8]) {
			expect(plan(count).flat().sort()).toEqual(files);
		}
	});

	it("puts each file, longest first, on the shard carrying least", () => {
		expect(plan(2)).toEqual([
			["a", "d"],
			["b", "c", "e", "f"],
		]);
	});

	it("gives the same plan whatever order vitest lists the files in", () => {
		const reversed = [...files].reverse();
		expect(planShard(reversed, timed, 1, 3)).toEqual(
			planShard(files, timed, 1, 3),
		);
	});

	it("charges a file the dataset never timed the median, not nothing", () => {
		const order = heaviestFirst(
			["new", "x", "y", "z"],
			seconds([
				["x", 30],
				["y", 10],
				["z", 20],
			]),
		);
		expect(order).toEqual([
			["x", 30],
			["new", 20],
			["z", 20],
			["y", 10],
		]);
	});
});

describe("secondsByFile", () => {
	it("keeps the timed rows and drops an untimed one", () => {
		expect(
			secondsByFile([
				{ file: "a", seconds: 2 },
				{ file: "b", seconds: null },
			]),
		).toEqual(seconds([["a", 2]]));
	});
});

describe("the sequencer", () => {
	let root: string | null = null;
	const roots: string[] = [];
	afterEach(() => {
		for (const dir of roots.splice(0))
			fs.rmSync(dir, { recursive: true, force: true });
		root = null;
	});

	const sequencer = (shard: { index: number; count: number } | undefined) => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "shard-plan-"));
		roots.push(root);
		return new ShardSequencer({ config: { root, shard } } as unknown as Vitest);
	};
	const specs = (paths: string[]) =>
		paths.map(
			(n) => ({ moduleId: path.join(root ?? "", n) }) as TestSpecification,
		);
	const names = (list: TestSpecification[]) =>
		list.map((s) => path.relative(root ?? "", s.moduleId));
	const writeDataset = (rows: string) => {
		const at = path.join(root ?? "", "docs/data/ci-shard-timings.csv");
		fs.mkdirSync(path.dirname(at), { recursive: true });
		fs.writeFileSync(at, `file,seconds,tests,status\n${rows}`);
	};

	it("splits by the dataset's timings and starts the longest first", async () => {
		const seq = sequencer({ index: 2, count: 2 });
		writeDataset(
			"a.test.ts,9.00,1,passed\nb.test.ts,5.00,1,passed\nc.test.ts,4.00,1,passed\n",
		);
		const mine = await seq.shard(
			specs(["a.test.ts", "b.test.ts", "c.test.ts"]),
		);
		expect(names(mine)).toEqual(["b.test.ts", "c.test.ts"]);
		expect(names(await seq.sort(specs(["c.test.ts", "b.test.ts"])))).toEqual([
			"b.test.ts",
			"c.test.ts",
		]);
	});

	it("falls back to vitest's own split where the dataset is unreadable", async () => {
		const seq = sequencer({ index: 1, count: 2 });
		const all = ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts"];
		const one = names(await seq.shard(specs(all)));
		const two = names(
			await sequencer({ index: 2, count: 2 }).shard(specs(all)),
		);
		expect([...one, ...two].sort()).toEqual(all);
	});
});
