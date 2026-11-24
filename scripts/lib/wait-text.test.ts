// @vitest-environment node

import { describe, expect, it } from "vitest";
import { SUBAGENT_WAIT } from "./wait-text.js";

describe("a subagent's wait text (#5724)", () => {
	it("names the wait for a test run the 30 s timeout moved to the background", () => {
		expect(SUBAGENT_WAIT).toContain(
			"a test run moved past `timeout: 30000` with `node scripts/in-flight-runs.js wait` in the foreground with `timeout: 600000`, re-run on `CEILING`",
		);
	});

	it("says the wait also covers the parent session's runs", () => {
		expect(SUBAGENT_WAIT).toContain(
			"it also waits on your parent's runs, which share your session id",
		);
	});
});
