// @vitest-environment node
/*
 * Pins scripts/lib/suite-budget.js (#5137): which files are summed, which
 * count towards a refusal, and the budget's derivation from TARGET_MS. Pure
 * functions over sweep rows, so no fixture on disk. Broken, a cut or a slow
 * sweep turns the armed sweep red, or growth passes unrefused.
 */

import { describe, expect, it } from "vitest";

const { ARMED_ENV, armedBy, judgeBudget } = require("./suite-budget.js");
const { SUITE_BUDGET_MS, TARGET_MS } = require("./suite-ceiling.js");

type Rows = Record<string, number | null>;
const sweep = (run: string, rows: Rows) => ({
	run,
	rows: Object.entries(rows).map(([file, seconds]) => ({ file, seconds })),
});
const BUDGET = { budgetMs: 1_000_000 };

describe("judgeBudget", () => {
	it("sums each file's median, so one slow sweep moves no file with three readings", () => {
		const v = judgeBudget(
			[
				sweep("3", { a: 900, b: 100 }),
				sweep("2", { a: 400, b: 100 }),
				sweep("1", { a: 400, b: 100 }),
			],
			{ ...BUDGET, armed: "abc" },
		);
		expect(v).toMatchObject({ judged: true, totalSeconds: 500, over: false });
		expect(v.refuses).toBe(false);
	});

	it("refuses a sum over the budget once armed", () => {
		const v = judgeBudget(
			[
				sweep("3", { a: 900, b: 200 }),
				sweep("2", { a: 900, b: 200 }),
				sweep("1", { a: 900, b: 200 }),
			],
			{ ...BUDGET, armed: "abc" },
		);
		expect(v).toMatchObject({ over: true, refuses: true, totalSeconds: 1100 });
		expect(v.slowest.map((f: { file: string }) => f.file)).toEqual(["a", "b"]);
	});

	it("only reports a sum over the budget until armed", () => {
		const v = judgeBudget(
			[
				sweep("3", { a: 1100 }),
				sweep("2", { a: 1100 }),
				sweep("1", { a: 1100 }),
			],
			{ ...BUDGET, armed: null },
		);
		expect(v).toMatchObject({ over: true, refuses: false });
	});

	it("reports a file new in the latest sweep at its one reading, and refuses on it only from its third", () => {
		const v = judgeBudget(
			[
				sweep("3", { a: 500, fresh: 600 }),
				sweep("2", { a: 500 }),
				sweep("1", { a: 500 }),
			],
			{ ...BUDGET, armed: "abc" },
		);
		expect(v).toMatchObject({
			totalSeconds: 1100,
			judgedSeconds: 500,
			over: true,
			refuses: false,
		});
	});

	it("sums only the files the newest sweep timed, so a deleted or renamed file counts nowhere", () => {
		const v = judgeBudget(
			[
				sweep("3", { renamed: 600, b: 100 }),
				sweep("2", { old: 600, b: 100 }),
				sweep("1", { old: 600, renamed: 600, b: 100 }),
			],
			{ ...BUDGET, armed: "abc" },
		);
		expect(v).toMatchObject({ totalSeconds: 700, files: 2, refuses: false });
	});

	it("judges nothing on fewer than three sweeps", () => {
		expect(judgeBudget([sweep("2", { a: 1 }), sweep("1", { a: 1 })])).toEqual({
			judged: false,
			runs: ["2", "1"],
		});
	});

	it("derives the budget from the 180 s target at 5 workers, 786 worker-seconds", () => {
		expect(SUITE_BUDGET_MS / TARGET_MS).toBeCloseTo(5 * (1497 / (343 * 5)));
		expect(Math.round(SUITE_BUDGET_MS / 1000)).toBe(786);
	});

	it("arms from the environment where nothing is committed, and only then", () => {
		expect(armedBy({})).toBeNull();
		expect(armedBy({ [ARMED_ENV]: "abc" })).toBe("abc");
	});
});
