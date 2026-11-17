// @vitest-environment node
/*
 * This repo's verdict canary (`commands.testCanary`, #5294): it passes on
 * every run but the verdict probe's, where WFC_VERDICT_PROBE=1 makes it fail,
 * so the probe sees `npm run test` name a red file (scripts/lib/verdict-probe.js).
 * Make it fail on a normal run and every suite goes red; make it pass under
 * the probe and every commit runs the suite again.
 */
import { expect, it } from "vitest";

it("fails only under the verdict probe", () => {
	expect(process.env.WFC_VERDICT_PROBE ?? "").toBe("");
});
