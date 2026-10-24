// @vitest-environment node
/*
 * Tests for scripts/lib/rule-table.js, which reads a gp_rule_path_rows table
 * back out of a guard's source (#2302). Three readers of gp_rule ids expand
 * through it: a misread drops a table's ids from the context budget, the census
 * digest and the guard registry's printed-rule check at once.
 */

import { describe, expect, it } from "vitest";

const { expandRuleTables, ruleTableRows } = require("./rule-table.js") as {
	expandRuleTables: (text: string) => string;
	ruleTableRows: (text: string) => string[][];
};

/** A gp_rule call's expansion of table `name`, as the guard spells it. */
const idsOf = (name: string) => `"$\{${name}[@]%% *}"`;

const SOURCE = [
	"rows=(",
	"  # A comment between rows (#1).",
	'  "gated docs/a.md governance roadmap"',
	'  "plain docs/b.md"',
	")",
	`gp_rule lead ${idsOf("rows")} tail`,
	"",
].join("\n");

describe("a gp_rule_path_rows table (#2302)", () => {
	it("reads each row's id, path and modules, past a comment", () => {
		expect(ruleTableRows(SOURCE)).toEqual([
			["gated", "docs/a.md", "governance", "roadmap"],
			["plain", "docs/b.md"],
		]);
	});

	it("puts the ids in the call in place, on the same line", () => {
		const out = expandRuleTables(SOURCE);
		expect(out.split("\n")[5]).toBe("gp_rule lead gated plain tail");
		expect(out.split("\n")).toHaveLength(SOURCE.split("\n").length);
	});

	it("reads the minified one-line form, a call mid-line included", () => {
		const minified = `rows=("gated docs/a.md governance" "plain docs/b.md")\nif x;then gp_rule lead ${idsOf("rows")} tail;fi\n`;
		expect(expandRuleTables(minified)).toContain(
			"gp_rule lead gated plain tail;",
		);
	});

	it("leaves the same expansion outside a gp_rule call alone", () => {
		const other = `printf "%s\\n" ${idsOf("names")}\n`;
		expect(expandRuleTables(other)).toBe(other);
		expect(ruleTableRows(other)).toEqual([]);
	});

	it("throws rather than drop the ids of a call naming no table", () => {
		expect(() => expandRuleTables(`gp_rule lead ${idsOf("nope")}\n`)).toThrow(
			/no literal nope=\(/,
		);
	});

	it("throws on a table holding an unquoted row", () => {
		expect(() =>
			expandRuleTables(`rows=(gated)\ngp_rule ${idsOf("rows")}\n`),
		).toThrow(/holds something other than double-quoted rows/);
	});
});
