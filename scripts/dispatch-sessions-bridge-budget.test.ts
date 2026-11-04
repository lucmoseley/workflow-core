// @vitest-environment node
/*
 * Pins the interop-bridge probe's shipped budget end to end (mantahostels#3111,
 * mantahostels#3535): a wedged Windows bridge refuses the dispatch inside the
 * 45s docs/environment.md §9 gives it, at the default 3 x 12s attempts.
 *
 * Over the run-cost budget (base §X8 (5)), and its own file, because the case sleeps through that whole budget, ~36 s, and
 * beside dispatch-sessions-bridge.test.ts's other cases would hold that file
 * past the 60 s per-file limit (#4299).
 *
 * Loosen it and a raised budget or attempt count lets a dispatch hang on a
 * wedged bridge past the time its caller reports in.
 */
import { describe, expect, it } from "vitest";
import { dispatchFixture } from "./lib/dispatch-sessions-testkit";

const fx = dispatchFixture();
const { stubClaude, regWedged, run } = fx;

describe("the interop-bridge probe's shipped budget (mantahostels#3111)", () => {
	it("refuses inside 45s at the shipped probe budget", {
		timeout: 90_000,
	}, () => {
		stubClaude({});
		const started = Date.now();
		const r = run(["sonnet", "/implement 341"], {
			CLAUDE_INTEROP_REG: regWedged(),
		});
		expect(r.code).toBe(5);
		// §X9: a process timeout: the shipped probe budget is the guarantee, and it bounds a real hung child.
		expect(Date.now() - started).toBeLessThan(45_000);
	});
});
