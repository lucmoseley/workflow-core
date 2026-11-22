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
	private timings: Map<string, number> | null | undefined;

	private seconds(): Map<string, number> | null {
		if (this.timings !== undefined) return this.timings;
		const named = process.env.WFC_SHARD_TIMINGS;
		if (!named) {
			this.timings = null;
			return null;
		}
		const at = path.resolve(this.ctx.config.root, named);
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
		if (untimed * 2 > byPath.size)
			process.stderr.write(
				`shard timings name ${byPath.size - untimed} of ${byPath.size} test files, the rest charged their median\n`,
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
