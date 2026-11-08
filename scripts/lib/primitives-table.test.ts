// @vitest-environment node
/*
 * Pins primitives-table.js's branches over fake ports: how it judges both
 * tables, reads a check's --json output into a breach count (#4119), which
 * findings gate, and which base paths the release judges (#4156, #4189).
 * check-primitives.test.ts holds the program's boundary cases.
 *
 * .husky/pre-commit and the release build refuse on this core, so a case
 * loosened here lets a row naming a missing path commit, or a release ship a
 * base row whose file it leaves out.
 */

import { describe, expect, it } from "vitest";
import {
	buildFindingReports,
	countPrimitives,
	judgePrimitives,
	parseBasePaths,
	parseBreaches,
	primitivesOutcome,
} from "./primitives-table.js";

const envelope = (fields: Record<string, unknown>) => JSON.stringify(fields);

const HEADER =
	"| Job | Primitive | Exemplar | Rule | Enforcing check |\n|---|---|---|---|---|\n";
const doc = (sections: string, rows: string) =>
	`${sections}\n## Primitives\n\n${HEADER}${rows}`;

/** A fake read and exists over two in-memory sides. */
const ports = (
	texts: { base: string | null; local: string | null },
	files: string[] = [],
) => ({
	read: (side: "base" | "local") => texts[side],
	exists: (side: "base" | "local", rel: string) =>
		files.includes(`${side}:${rel}`),
});

describe("judgePrimitives", () => {
	const BaseIds = "## §N — Names\n### §N1 · One\n";

	it("is broken, judging nothing, where the base cannot be read", () => {
		expect(judgePrimitives(ports({ base: null, local: null }))).toEqual({
			rows: [],
			findings: [],
			broken: "the code standards base is unreadable at the plugin root",
			unreadable: [],
		});
	});

	it("passes a row whose paths exist and whose § id the base defines", () => {
		const result = judgePrimitives(
			ports(
				{
					base: doc(BaseIds, "| J | P | `e.js` | §N1 | `c.js` |\n"),
					local: null,
				},
				["base:e.js", "base:c.js"],
			),
		);
		expect(result.findings).toEqual([]);
		expect(result.rows).toHaveLength(1);
	});

	it("names each missing path, an uncited Rule and empty cells, by side and line", () => {
		const { findings } = judgePrimitives(
			ports({
				base: doc(BaseIds, "|  |  | `e.js` | none | `c.js` |\n"),
				local: null,
			}),
		);
		expect(findings.map((f) => f.message)).toEqual([
			"its exemplar `e.js` does not exist — point the cell at the file that does the job now, or drop the row",
			"its enforcing check `c.js` does not exist — name the program that refuses a breach now, or `Standards axis criterion`",
			"its Rule cell cites no § id",
			"its Job cell is empty",
			"its Primitive cell is empty",
		]);
		expect(findings.every((f) => f.side === "base" && f.line === 8)).toBe(true);
	});

	it("judges no check path on a Standards axis criterion row, and names a cell with no backticked path", () => {
		const { findings } = judgePrimitives(
			ports({
				base: doc(
					BaseIds,
					"| J | P | e.js | §N1 | Standards axis criterion |\n| K | P | `e.js` | §N1 | c.js |\n",
				),
				local: null,
			}),
		);
		expect(findings.map((f) => f.message)).toEqual([
			"its Exemplar cell names no backticked path",
			"its exemplar `e.js` does not exist — point the cell at the file that does the job now, or drop the row",
			"its Enforcing check cell names neither a backticked check path nor `Standards axis criterion`",
		]);
	});

	it("lets a local row cite a local § id, and never a base row", () => {
		const local = doc(
			"## §L — Local\n",
			"| Local job | P | `e.js` | §L | Standards axis criterion |\n",
		);
		const base = doc(
			BaseIds,
			"| J | P | `e.js` | §L | Standards axis criterion |\n",
		);
		const { findings } = judgePrimitives(
			ports({ base, local }, ["base:e.js", "local:e.js"]),
		);
		expect(findings).toEqual([
			{
				side: "base",
				line: 8,
				job: "J",
				message:
					'its Rule cell cites §L, which no standards file defines — cite the § that states the primitive, or write one under base §0 "How a rule enters"',
			},
		]);
	});

	it("names a local row taking a base row's job, case and spacing aside", () => {
		const base = doc(
			BaseIds,
			"| Some  Job | `p` | `e.js` | §N1 | Standards axis criterion |\n",
		);
		const local = doc(
			"",
			"| some job | P | `e.js` | §N1 | Standards axis criterion |\n",
		);
		const { findings } = judgePrimitives(
			ports({ base, local }, ["base:e.js", "local:e.js"]),
		);
		expect(findings.map((f) => [f.side, f.message])).toEqual([
			[
				"local",
				"it names the job of the base row at line 8, whose primitive is `p`; a local row adds a job the base has none for (base §0) — drop the local row, or name a job of its own",
			],
		]);
	});

	it("reads a side with no Primitives heading as no rows, and one whose table will not parse as a finding and a blind count", () => {
		const result = judgePrimitives(
			ports({
				base: "# Base\n",
				local: "## Primitives\n\n| Job | Typo |\n|---|---|\n",
			}),
		);
		expect(result).toEqual({
			rows: [],
			findings: [
				{
					side: "local",
					line: 0,
					job: "",
					message:
						"its Primitives table's header is not | Job | Primitive | Exemplar | Rule | Enforcing check |",
				},
			],
			broken: null,
			unreadable: ["the local table is unreadable"],
		});
	});
});

describe("buildFindingReports", () => {
	const base = { side: "base" as const, line: 4, job: "J", message: "m" };
	const local = { side: "local" as const, line: 0, job: "", message: "n" };

	it("warns on a base row's fault in an adopter, as the plugin's to fix, and fails every other", () => {
		expect(buildFindingReports([base, local], true)).toEqual([
			{
				message:
					'docs/code-standards-base.md:4 (row "J"): m — the plugin\'s to fix',
				file: "docs/code-standards-base.md",
				gates: false,
			},
			{
				message: "docs/code-standards.md: n",
				file: "docs/code-standards.md",
				gates: true,
			},
		]);
	});

	it("fails a base row's fault in the core", () => {
		expect(buildFindingReports([base], false)).toEqual([
			{
				message: 'docs/code-standards-base.md:4 (row "J"): m',
				file: "docs/code-standards-base.md",
				gates: true,
			},
		]);
	});
});

describe("parseBreaches", () => {
	it("counts FAIL findings and no WARN", () => {
		const findings = [
			{ severity: "FAIL" },
			{ severity: "WARN" },
			{ severity: "FAIL" },
		];
		expect(parseBreaches(envelope({ outcome: "WARN", findings }), 0)).toEqual({
			count: 2,
		});
	});

	it("reads a SKIP with empty findings as 0 (#4119)", () => {
		expect(
			parseBreaches(envelope({ outcome: "SKIP", findings: [] }), 0),
		).toEqual({ count: 0 });
	});

	it("keeps a SKIP with no findings array unknown (#4119)", () => {
		expect(parseBreaches(envelope({ outcome: "SKIP" }), 0)).toEqual({
			unknown: "its envelope carries no findings array",
		});
	});

	it("keeps a BROKEN unknown, findings or none", () => {
		expect(
			parseBreaches(envelope({ outcome: "BROKEN", findings: [] }), 2),
		).toEqual({ unknown: "it answered BROKEN" });
	});

	it("keeps output that is no envelope unknown, naming the exit", () => {
		expect(parseBreaches("not json", 2)).toEqual({
			unknown: "it printed no --json envelope (exit 2)",
		});
		expect(parseBreaches("null", 0)).toEqual({
			unknown: "its envelope carries no findings array",
		});
	});
});

describe("parseBasePaths", () => {
	const table = (rows: string) =>
		`## Primitives\n\n| Job | Primitive | Exemplar | Rule | Enforcing check |\n|---|---|---|---|---|\n${rows}`;

	it("names each Exemplar path and each program Enforcing check, by line, never the Primitive cell (#4156)", () => {
		expect(
			parseBasePaths(
				table(
					"| A | `scripts/p.js` | `scripts/a.js`, `scripts/b.sh` | §N1 | `scripts/check-a.js` |\n" +
						"| B | `x` | `scripts/c.js` | §N1 | Standards axis criterion |\n",
				),
			),
		).toEqual({
			paths: [
				{ line: 5, rel: "scripts/a.js" },
				{ line: 5, rel: "scripts/b.sh" },
				{ line: 5, rel: "scripts/check-a.js" },
				{ line: 6, rel: "scripts/c.js" },
			],
		});
	});

	it("names why a table it cannot read is unreadable, never an empty path list (#4189)", () => {
		expect(
			parseBasePaths("## Primitives\n\n| Job | Typo |\n|---|---|\n"),
		).toEqual({
			unreadable:
				"its Primitives table's header is not | Job | Primitive | Exemplar | Rule | Enforcing check |",
		});
		expect(parseBasePaths("## Primitives\n\nNo table.\n")).toEqual({
			unreadable: "its Primitives section holds no table",
		});
	});

	it("names none from a base with no Primitives heading", () => {
		expect(parseBasePaths("# Base\n")).toEqual({ paths: [] });
	});
});

describe("countPrimitives", () => {
	const row = (check: string) => ({
		side: "base" as const,
		line: 1,
		job: "J",
		primitive: "P",
		exemplar: "`e.js`",
		rule: "§0",
		check,
	});
	const heresies = () => ({ count: 0 });

	it("sums each check's count once, in the order asked", async () => {
		const asked: string[] = [];
		const line = await countPrimitives(
			{ rows: [row("`a.js`"), row("`b.js`, `a.js`")], unreadable: [] },
			{
				countBreaches: async (checks: { rel: string }[]) => {
					asked.push(...checks.map((c) => c.rel));
					return checks.map((_, i) => ({ count: i + 1 }));
				},
				readNewHeresies: heresies,
			},
		);
		expect(asked).toEqual(["a.js", "b.js"]);
		expect(line).toContain("2 enforced, 3 open breaches");
	});

	it("counts nothing where a table is unreadable, naming it for both counts", async () => {
		const line = await countPrimitives(
			{ rows: [row("`a.js`")], unreadable: ["the local table is unreadable"] },
			{
				countBreaches: async () => {
					throw new Error("asked a blind count");
				},
				readNewHeresies: heresies,
			},
		);
		expect(line).toBe(
			"primitives: enforced unknown (the local table is unreadable), open breaches unknown (the local table is unreadable), 0 new heresies since the last sweep",
		);
	});

	it("names a check whose count never came back, never reading it as 0", async () => {
		const line = await countPrimitives(
			{ rows: [row("`a.js`"), row("`b.js`")], unreadable: [] },
			{ countBreaches: async () => [{ count: 2 }], readNewHeresies: heresies },
		);
		expect(line).toContain("open breaches unknown (b.js: no count came back)");
	});
});

describe("primitivesOutcome", () => {
	it("carries the count line on the OK line, and beside findings only where there are some", () => {
		const line =
			"primitives: 1 enforced, 0 open breaches, 0 new heresies since the last sweep";
		expect(primitivesOutcome({ rows: 2, line, findings: 0 })).toEqual({
			okLine: `2 primitives row(s), every path and § id real. ${line}.`,
			extraLine: null,
		});
		expect(primitivesOutcome({ rows: 2, line, findings: 1 }).extraLine).toBe(
			`${line}.`,
		);
		expect(primitivesOutcome({ rows: 2, line: null, findings: 1 })).toEqual({
			okLine: "2 primitives row(s), every path and § id real.",
			extraLine: null,
		});
	});
});
