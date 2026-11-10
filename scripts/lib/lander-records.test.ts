// @vitest-environment node
/*
 * lib/lander-records.js through each record's read and write on a real temp
 * file, as the lander's next run reads what an older lander wrote (#4897,
 * #4912). The older-shape case pins the records' no-version contract: break
 * it and a lander upgraded mid-batch reads its own pipeline as torn and
 * drops the batches in flight.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dropRecord, pipelineRecord, readDropFile } from "./lander-records.js";

let dir: string;
let file: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "lander-records-"));
	file = path.join(dir, "record.json");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const noFile = { kind: "red" as const, files: [], jobs: ["Lint and types"] };

/** A batch with every field the current shape carries set. */
const b = {
	slot: 1,
	members: [{ name: "a", sha: "s0", pushedAt: 1 }],
	deferred: ["b"],
	dropped: [],
	onto: "m0",
	integration: "s1",
	phase: "serial" as const,
	ahead: ["a"],
	blame: { files: ["a.ts"], base: [], members: ["a"] },
	isolated: [{ name: "a", sha: "s0", iso: "i0" }],
	serial: { landed: [], step: { name: "a", sha: "t0", onto: "m0" } },
	hold: {
		kind: "base" as const,
		main: "m0",
		files: ["a.ts"],
		ticket: 90,
		retakeAt: 5,
	},
	bases: [{ sha: "m0", files: ["a.ts"], verdict: noFile }],
};

/** The pipeline with `x` as its search and the line's head. */
const holding = (x: unknown) => ({ line: [x], search: x, depth: 1 });

const writeRaw = (value: unknown) =>
	fs.writeFileSync(
		file,
		typeof value === "string" ? value : JSON.stringify(value),
	);

describe("the pipeline record", () => {
	it("reads back what it wrote", () => {
		pipelineRecord(file).write(holding(b) as never);
		expect(pipelineRecord(file).read()).toEqual({
			kind: "read",
			value: holding(b),
		});
	});

	it("reads a batch written before deferred as having none", () => {
		const { deferred, ...older } = b;
		writeRaw(holding(older));
		expect(pipelineRecord(file).read()).toEqual({
			kind: "read",
			value: holding({ ...b, deferred: [] }),
		});
	});

	it("reads a batch written before bases as having asked none", () => {
		const { bases, ...older } = b;
		writeRaw(holding(older));
		expect(pipelineRecord(file).read()).toEqual({
			kind: "read",
			value: holding({ ...b, bases: [] }),
		});
	});

	it("reads a base hold written before retakeAt with none", () => {
		const { retakeAt, ...hold } = b.hold;
		writeRaw(holding({ ...b, hold }));
		expect(pipelineRecord(file).read()).toEqual({
			kind: "read",
			value: holding({ ...b, hold }),
		});
	});

	it("ignores a field it does not know", () => {
		writeRaw({ ...holding({ ...b, parked: true }), version: 2 });
		expect(pipelineRecord(file).read()).toEqual({
			kind: "read",
			value: holding(b),
		});
	});

	it("reads a file that is no pipeline as torn, and a missing one as absent", () => {
		expect(pipelineRecord(file).read()).toEqual({ kind: "absent" });
		for (const torn of [
			holding({ ...b, phase: "parked" }),
			holding({ ...b, hold: { kind: "refused", main: "m0" } }),
			holding({ ...b, hold: { ...b.hold, retakeAt: "soon" } }),
			holding({ ...b, bases: [{ sha: "m0", files: ["a.ts"] }] }),
			holding({ ...b, bases: null }),
			holding({ ...b, deferred: [1] }),
			holding({ ...b, slot: "1" }),
			{ line: [b], search: null },
			b,
			'{"line": [',
		]) {
			writeRaw(torn);
			expect(pipelineRecord(file).read()).toEqual({ kind: "torn" });
		}
	});
});

describe("the drop record", () => {
	const d = {
		name: "a",
		sha: "s0",
		ref: "dropped/a",
		onto: "m0",
		cause: { kind: "conflict" as const, name: "a", files: ["x.txt"] },
		ticket: null,
		at: 1,
	};
	const red = {
		...d,
		cause: { kind: "red" as const, name: "a", files: ["x.ts"], iso: "i0" },
		reapedAt: 2,
	};
	const collision = {
		...d,
		cause: {
			kind: "collision" as const,
			name: "a",
			files: [],
			step: "t0",
			after: ["b"],
		},
	};

	it("reads back what it wrote, a row that is no drop skipped", () => {
		dropRecord(file).write([
			d,
			red,
			collision,
			{ ...d, ref: 3 } as never,
			{ ...red, cause: { ...red.cause, iso: 4 } } as never,
			{ ...d, cause: { ...d.cause, kind: "parked" } } as never,
		]);
		expect(dropRecord(file).read()).toEqual([d, red, collision]);
	});

	it("reads a file that is no list as torn, and as no drops", () => {
		expect(readDropFile(file)).toEqual({ kind: "absent" });
		writeRaw("[{");
		expect(readDropFile(file)).toEqual({ kind: "torn" });
		expect(dropRecord(file).read()).toEqual([]);
	});
});
