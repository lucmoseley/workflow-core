// @vitest-environment node
/*
 * lib/lander-records.js through each record's read and write on a real temp
 * file, as the lander's next run reads what an older lander wrote (#4897,
 * #4912). The older-shape cases pin the records' no-version contract: break
 * them and a lander upgraded mid-batch reads its own pipeline as torn and
 * drops the batches in flight.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Cause, Drop, QuotedFailure, RedMarks } from "./lander-records.js";
import {
	dropRecord,
	parseVerdict,
	pipelineRecord,
	readDropFile,
	readOwedDrops,
} from "./lander-records.js";
import type { Failure, Verdict } from "./queue-lander.js";

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

describe("a torn pipeline record moved aside (#4905)", () => {
	const at = Date.parse("2026-11-06T12:00:00Z");
	const torn = '{"line": [';

	it("renames the file beside itself, its contents intact, and never over an earlier one", () => {
		const record = pipelineRecord(file, () => at);
		fs.writeFileSync(file, torn);

		const first = record.quarantine();
		fs.writeFileSync(file, `${torn} 2`);
		const second = record.quarantine();

		expect(first).toBe(`${file}.torn-2026-11-06T12:00:00.000Z`);
		expect(second).not.toBe(first);
		expect(path.dirname(second)).toBe(dir);
		expect(fs.readFileSync(first, "utf8")).toBe(torn);
		expect(fs.readFileSync(second, "utf8")).toBe(`${torn} 2`);
		expect(fs.existsSync(file)).toBe(false);
		expect(record.read()).toEqual({ kind: "absent" });
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
		state: "open" as const,
		decidedAt: 1,
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
	const typed = {
		...red,
		cause: { ...red.cause, files: [], typecheck: ["a.js(1,1): error TS1: x"] },
	};

	const cited = {
		...red,
		cause: {
			...red.cause,
			runs: [31, 32],
			mainRun: 7,
			failures: [{ file: "x.ts", test: "a > b", message: "expected 1" }],
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
			typed,
			{ ...typed, cause: { ...typed.cause, typecheck: "x" } } as never,
			cited,
			{ ...cited, cause: { ...cited.cause, runs: ["31"] } } as never,
			{ ...cited, cause: { ...cited.cause, mainRun: "7" } } as never,
			{
				...cited,
				cause: { ...cited.cause, failures: [{ file: "x.ts" }] },
			} as never,
		]);
		expect(dropRecord(file).read()).toEqual([d, red, collision, typed, cited]);
	});

	it("reads an entry written before its decision state shipped as ticketed where it names a ticket, else open, decided when it was dropped", () => {
		const { state: _state, decidedAt: _decidedAt, ...old } = d;
		writeRaw(JSON.stringify([old, { ...old, sha: "s1", ticket: 7, at: 5 }]));

		expect(dropRecord(file).read()).toEqual([
			d,
			{ ...d, sha: "s1", ticket: 7, at: 5, state: "ticketed", decidedAt: 5 },
		]);
	});

	it("keeps a settled entry's main sha, and skips an entry in a state it does not know", () => {
		const settled = {
			...d,
			state: "settled" as const,
			decidedAt: 9,
			settledOn: "m9",
			reapedAt: 9,
		};
		dropRecord(file).write([settled, { ...d, state: "parked" } as never]);

		expect(dropRecord(file).read()).toEqual([settled]);
	});

	it("reads as owed a decision only the open drops with no ticket, no reap and no filing refused for good", () => {
		dropRecord(file).write([
			d,
			{ ...d, sha: "s4", filingRefused: "rule:x refused it" },
			{ ...d, sha: "s1", ticket: 7, state: "ticketed" },
			{ ...d, sha: "s2", state: "settled", settledOn: "m9" },
			{ ...d, sha: "s3", reapedAt: 4 },
		]);

		expect(readOwedDrops(file).map((x) => x.sha)).toEqual(["s0"]);
	});

	it("reads a file that is no list as torn, and as no drops", () => {
		expect(readDropFile(file)).toEqual({ kind: "absent" });
		writeRaw("[{");
		expect(readDropFile(file)).toEqual({ kind: "torn" });
		expect(dropRecord(file).read()).toEqual([]);
	});
});

/*
 * Every field each type holds, set, so a field the type gains fails the
 * type-check until it is here, then the round trip until the reader keeps it
 * (#5077).
 */
describe("every field a verdict or a cause holds", () => {
	const failure = {
		file: "x.ts",
		test: "a > b",
		message: "expected 1",
		signature: "expected <n>",
	} satisfies Required<Failure>;
	const verdicts = {
		green: {
			kind: "green",
			run: 3,
			named: 4,
			cleared: ["y.ts"],
		} satisfies Required<Extract<Verdict, { kind: "green" }>>,
		red: {
			kind: "red",
			files: ["x.ts"],
			run: 5,
			jobs: ["Tests"],
			failures: [failure],
			retried: true,
			noRun: true,
			typecheck: ["a.js(1,1): error TS1: x"],
		} satisfies Required<Extract<Verdict, { kind: "red" }>>,
	} satisfies Record<Exclude<Verdict["kind"], "unknown">, Verdict>;

	it.each(Object.values(verdicts))("reads a $kind verdict back whole", (v) => {
		expect(parseVerdict(JSON.parse(JSON.stringify(v)))).toEqual(v);
	});

	const quoted = {
		file: "x.ts",
		test: "a > b",
		message: "expected 1",
	} satisfies Required<QuotedFailure>;
	const marks = {
		noRun: true,
		typecheck: ["a.js(1,1): error TS1: x"],
		runs: [31, 32],
		failures: [quoted],
	} satisfies Required<RedMarks>;
	const causes = {
		conflict: {
			kind: "conflict",
			name: "a",
			files: ["x.txt"],
		} satisfies Required<Extract<Cause, { kind: "conflict" }>>,
		refused: {
			kind: "refused",
			name: "a",
			reason: "rule:x refused it",
		} satisfies Required<Extract<Cause, { kind: "refused" }>>,
		red: {
			kind: "red",
			name: "a",
			files: ["x.ts"],
			iso: "i0",
			mainRun: 7,
			...marks,
		} satisfies Required<Extract<Cause, { kind: "red" }>>,
		collision: {
			kind: "collision",
			name: "a",
			files: ["x.ts"],
			step: "t0",
			after: ["b"],
			...marks,
		} satisfies Required<Extract<Cause, { kind: "collision" }>>,
		unrecorded: { kind: "unrecorded", name: "a" } satisfies Required<
			Extract<Cause, { kind: "unrecorded" }>
		>,
	} satisfies Record<Cause["kind"], Cause>;

	const dropOf = (cause: unknown) =>
		({
			name: "a",
			sha: "s0",
			ref: "dropped/a",
			onto: "m0",
			cause,
			ticket: null,
			at: 1,
			state: "open",
			decidedAt: 1,
		}) as Drop;

	it.each(Object.values(causes))("reads a $kind cause back whole", (cause) => {
		dropRecord(file).write([dropOf(cause)]);
		expect(dropRecord(file).read()).toEqual([dropOf(cause)]);
	});

	it.each(Object.values(causes))(
		"skips a $kind cause any one of whose fields is ill-typed",
		(cause) => {
			const ill = [
				...Object.keys(cause).map((key): [string, unknown] => [
					key,
					{ ...cause, [key]: { ill: true } },
				]),
				...("failures" in cause ? Object.keys(quoted) : []).map(
					(key): [string, unknown] => [
						`failures[0].${key}`,
						{ ...cause, failures: [{ ...quoted, [key]: { ill: true } }] },
					],
				),
			];
			for (const [key, bad] of ill) {
				dropRecord(file).write([dropOf(bad)]);
				expect(dropRecord(file).read(), key).toEqual([]);
			}
		},
	);
});
