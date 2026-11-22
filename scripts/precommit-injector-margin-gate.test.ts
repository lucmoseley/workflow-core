// @vitest-environment node

import { describe, expect, it } from "vitest";
import { registerTempCleanup, stagedRepo } from "./lib/precommit-gate-harness";
import {
	dispatchStubbed,
	type GateRow,
	patternRow,
} from "./lib/precommit-gate-testkit";
import { GATES } from "./lib/precommit-gates.js";

const CHECKER = "scripts/check-injector-margin.js";
const BUDGET = "scripts/check-context-budget.js";
const { TRACKER_TEXT } =
	require("./lib/load-text-module.js") as typeof import("./lib/load-text-module.js");
const { MARGIN_INPUTS } =
	require("./lib/injector-margin.js") as typeof import("./lib/injector-margin.js");
const REVIEW_RULES = MARGIN_INPUTS.filter((rel) =>
	rel.startsWith("docs/agents/rules/"),
);

const temps = registerTempCleanup();

const ROW = patternRow(CHECKER);
const PATTERN = ROW.arm.pattern;

const STUB_MARKER = "STUB-TRACKER_TEXT-MARGIN-RAN";

async function runRow(opts: {
	staged: Record<string, string>;
	checkerExit: number;
	row?: GateRow;
}): Promise<{ code: number; output: string }> {
	const { root } = stagedRepo("injector-margin-gate-", temps, {}, opts.staged);
	return dispatchStubbed(root, opts.row ?? ROW, {
		result: { exit: opts.checkerExit, stdout: `${STUB_MARKER}\n`, stderr: "" },
	});
}

describe("the pre-commit injector-margin row", () => {
	it("is a gating checker row on the staged index, printing its pass", () => {
		expect(ROW).toMatchObject({
			id: "injector-margin",
			lander: "batch",
			policy: "gate",
			kind: "checker",
			args: ["--index"],
		});
		expect("quietPass" in ROW).toBe(false);
	});

	it("runs after the context-budget row, which is the cheaper, broader one", () => {
		const at = (script: string) => GATES.findIndex((g) => g.script === script);
		expect(at(BUDGET)).toBeGreaterThan(-1);
		expect(at(CHECKER)).toBeGreaterThan(at(BUDGET));
	});

	it("arms on exactly the files the checker measures", () => {
		expect(MARGIN_INPUTS).toContain(TRACKER_TEXT);
		expect(REVIEW_RULES).toHaveLength(3);
		for (const rel of [TRACKER_TEXT, ...REVIEW_RULES])
			expect(PATTERN.test(rel), rel).toBe(true);
	});

	it("runs the checker for a commit staging only a rule fragment it reads", async () => {
		const { code, output } = await runRow({
			staged: { [REVIEW_RULES[0] as string]: "x\n" },
			checkerExit: 0,
		});
		expect(code).toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	it("runs the checker for a commit staging the injector", async () => {
		const { code, output } = await runRow({
			staged: { [TRACKER_TEXT]: "x\n" },
			checkerExit: 0,
		});
		expect(code).toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	it("fails the commit when a payload is over the threshold", async () => {
		const { code, output } = await runRow({
			staged: { [TRACKER_TEXT]: "x\n" },
			checkerExit: 1,
		});
		expect(code).toBe(1);
		expect(output).toContain(STUB_MARKER);
	});

	it("fails the commit when the checker reports BROKEN", async () => {
		const { code, output } = await runRow({
			staged: { [TRACKER_TEXT]: "x\n" },
			checkerExit: 2,
		});
		expect(code).toBe(2);
		expect(output).toContain(STUB_MARKER);
	});

	it("does not run the checker for a commit that leaves the text module alone", async () => {
		const { code, output } = await runRow({
			staged: {
				"docs/agents/issue-tracker.md": "x\n",
				"docs/agents/rules/review-standards-axis.txt": "x\n",
				"app/page.tsx": "x\n",
			},
			checkerExit: 1,
		});
		expect(code).toBe(0);
		expect(output).not.toContain(STUB_MARKER);
	});

	it("does not fire on a path that only resembles the text module", async () => {
		const { code } = await runRow({
			staged: {
				[`vendor/${TRACKER_TEXT}`]: "x\n",
				[`${TRACKER_TEXT}.bak`]: "x\n",
			},
			checkerExit: 1,
		});
		expect(code).toBe(0);
	});
});

describe("mutations of the row are caught by the cases above", () => {
	const withPattern = (find: string | RegExp, replace: string): GateRow => {
		const source = PATTERN.source.replace(find, replace);
		expect(source, `mutation '${find}' did not apply`).not.toBe(PATTERN.source);
		return { ...ROW, arm: { pattern: new RegExp(source) } };
	};

	it("stops failing the commit when the row only warns", async () => {
		const { code } = await runRow({
			staged: { [TRACKER_TEXT]: "x\n" },
			checkerExit: 1,
			row: { ...ROW, policy: "warn" },
		});
		expect(code).toBe(0);
	});

	it("runs the checker out of scope when the path filter is dropped", async () => {
		const { code, output } = await runRow({
			staged: { "app/page.tsx": "x\n" },
			checkerExit: 1,
			row: { ...ROW, arm: { always: true } },
		});
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	it("fires on a look-alike path when the pattern loses its leading anchor", async () => {
		const { code, output } = await runRow({
			staged: { [`vendor/${TRACKER_TEXT}`]: "x\n" },
			checkerExit: 1,
			row: withPattern(/^\^/, ""),
		});
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	it("stops firing at all when the pattern names another file", async () => {
		const { code } = await runRow({
			staged: { [TRACKER_TEXT]: "x\n" },
			checkerExit: 1,
			row: withPattern("tracker-inject-text\\.js", "check-context-budget\\.js"),
		});
		expect(code).toBe(0);
	});
});
