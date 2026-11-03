// @vitest-environment node
/*
 * Pins how primitives-table.js reads a check's --json output into a breach
 * count (#4119), and which base paths an adopter judges (#4156).
 * check-primitives.test.ts holds the program's boundary cases.
 */

import { describe, expect, it } from "vitest";
import { parseBasePaths, parseBreaches } from "./primitives-table.js";

const envelope = (fields: Record<string, unknown>) => JSON.stringify(fields);

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
		).toEqual([
			{ line: 5, rel: "scripts/a.js" },
			{ line: 5, rel: "scripts/b.sh" },
			{ line: 5, rel: "scripts/check-a.js" },
			{ line: 6, rel: "scripts/c.js" },
		]);
	});

	it("names none from a table it cannot read (#4156)", () => {
		expect(
			parseBasePaths("## Primitives\n\n| Job | Typo |\n|---|---|\n"),
		).toEqual([]);
	});
});
