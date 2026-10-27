/*
 * vitest-shard-sequencer.ts — splits a `--shard=k/n` run by recorded file
 * timings rather than by file count, and starts each shard's longest files first (#2413). The plan is
 * scripts/lib/shard-plan.js's; the timings are docs/data/ci-shard-timings.csv,
 * refreshed from an Actions run with `node scripts/suite-timings.js extract`.
 *
 * An unsharded run keeps vitest's own order. The lander's local tester runs
 * `fullTestShards` sharded runs (lib/local-tester.js), which this packs by
 * the same Actions timings: their ratios, not their seconds, set the plan.
 *
 * IMPLICIT:  reads docs/data/ci-shard-timings.csv on every sharded run.
 * JUSTIFIED: fail-safe — an unreadable dataset falls back to vitest's own split, which runs every file once all the same.
 * DEFEAT:    drop `sequence.sequencer` from vitest.config.ts, which puts the shards back on vitest's count split and a shard's time back on luck.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { TestSpecification } from "vitest/node";
import { BaseSequencer } from "vitest/node";

const require = createRequire(import.meta.url);
const {
	heaviestFirst,
	planShard,
	secondsByFile,
} = require("./lib/shard-plan.js");
const { parseCsv } = require("./lib/suite-timings.js");

const DATASET = "docs/data/ci-shard-timings.csv";

/** The specs `paths` name, in that order; each path came from `byPath`. */
function specsAt(
	byPath: Map<string, TestSpecification>,
	paths: string[],
): TestSpecification[] {
	return paths.map((f) => {
		const spec = byPath.get(f);
		if (spec === undefined)
			throw new Error(`the shard plan named ${f}, which vitest never listed`);
		return spec;
	});
}

export default class ShardSequencer extends BaseSequencer {
	/* Read once per run: `shard` and `sort` both charge by it. Undefined
	 * until read; null once the read failed. */
	private timings: Map<string, number> | null | undefined;

	private seconds(): Map<string, number> | null {
		if (this.timings !== undefined) return this.timings;
		const at = path.join(this.ctx.config.root, DATASET);
		let read: Map<string, number> | null = null;
		try {
			read = secondsByFile(parseCsv(fs.readFileSync(at, "utf8")).rows);
		} catch (error) {
			process.stderr.write(
				`shard timings unread at ${at} (${String(error)}) — splitting by file count instead\n`,
			);
		}
		this.timings = read;
		return read;
	}

	private relative(spec: TestSpecification): string {
		return path.relative(this.ctx.config.root, spec.moduleId);
	}

	override async shard(
		files: TestSpecification[],
	): Promise<TestSpecification[]> {
		const seconds = this.seconds();
		if (seconds === null) return super.shard(files);
		const shard = this.ctx.config.shard;
		if (!shard)
			throw new Error("vitest called shard() on a run with no --shard");
		const byPath = new Map(files.map((f) => [this.relative(f), f]));
		const untimed = [...byPath.keys()].filter((f) => !seconds.has(f)).length;
		/* Most files untimed reads as a dataset whose paths match nothing,
		 * which packs no better than vitest's own split. */
		if (untimed * 2 > byPath.size)
			process.stderr.write(
				`shard timings name ${byPath.size - untimed} of ${byPath.size} test files — refresh ${DATASET}\n`,
			);
		return specsAt(
			byPath,
			planShard([...byPath.keys()], seconds, shard.index, shard.count),
		);
	}

	override async sort(
		files: TestSpecification[],
	): Promise<TestSpecification[]> {
		if (!this.ctx.config.shard) return super.sort(files);
		const byPath = new Map(files.map((f) => [this.relative(f), f]));
		const order: [string, number][] = heaviestFirst(
			[...byPath.keys()],
			this.seconds() ?? new Map(),
		);
		return specsAt(
			byPath,
			order.map(([f]) => f),
		);
	}
}
