// @vitest-environment node
/*
 * Pins the write routes' verdict on a gate `check:` (#3487), over real shell
 * as check-gates.test.ts runs it. Loosen a case and a silent check is written again, to hold
 * a met gate unjudged until the sweep's repair judge reaches it.
 */

import os from "node:os";
import { describe, expect, it } from "vitest";

const { addedCheckVerdict } = require("./gate-check.js");

const cwd = os.tmpdir();
const gate = (check: string) =>
	`**Gated on:** it lands — check: ${check} — abandon if: it is dropped\n`;
/* Ample for `true`, `false` and `echo`. */
const verdictOf = (before: string, after: string, run = true) =>
	addedCheckVerdict(before, after, { run, cwd, timeoutMs: 5000 });

describe("a check the write adds", () => {
	it.each([
		["true", "NO-OUTPUT"],
		["false", "DEAD"],
		["`echo `x``", "NOT-A-COMMAND"],
	])("refuses `%s` as %s, naming the printing fix", (check, state) => {
		const { refusals } = verdictOf("", gate(check));
		expect(refusals).toHaveLength(1);
		expect(refusals[0]).toContain(`reads as ${state}`);
		expect(refusals[0]).toContain('&& echo "on main" || echo "not on main"');
	});

	it("passes a check that prints a reading, whatever its exit code", () => {
		for (const check of ["`echo on main`", "echo nothing; false"])
			expect(verdictOf("", gate(check))).toEqual({
				refusals: [],
				warnings: [],
			});
	});

	// A real kill: OVER-BUDGET comes only from run-budgeted.js's own timeout.
	it("warns a check that runs past its budget, and refuses nothing", () => {
		const { refusals, warnings } = addedCheckVerdict("", gate("sleep 5"), {
			run: true,
			cwd,
			timeoutMs: 200,
		});
		expect(refusals).toEqual([]);
		expect(warnings.join("\n")).toContain("OVER-BUDGET");
	});

	it("judges only the parse where the route cannot run it", () => {
		expect(verdictOf("", gate("true"), false).refusals).toEqual([]);
		expect(verdictOf("", gate("true"), false).warnings[0]).toContain(
			"was not run here",
		);
		expect(verdictOf("", gate("`echo `x``"), false).refusals).toHaveLength(1);
	});
});

describe("a check the write does not add", () => {
	it("leaves an unchanged gate line and a gate with no check alone", () => {
		const held = gate("true");
		expect(verdictOf(held, `${held}more prose\n`)).toEqual({
			refusals: [],
			warnings: [],
		});
		expect(
			verdictOf("", "**Gated on:** it lands — abandon if: it is dropped\n"),
		).toEqual({ refusals: [], warnings: [] });
	});
});
