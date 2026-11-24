// @vitest-environment node

import { describe, expect, it } from "vitest";
import { SUBAGENT_WAIT } from "./wait-text.js";

describe("SUBAGENT_WAIT", () => {
	it("names the wait for a test run the 30 s timeout moved to the background (#5724)", () => {
		expect(SUBAGENT_WAIT).toContain(
			"a test run moved past `timeout: 30000` with `node scripts/in-flight-runs.js wait` re-run until `DONE`",
		);
	});

	it("says the wait also covers the parent session's runs", () => {
		expect(SUBAGENT_WAIT).toContain(
			"it also waits on your parent's runs, which share your session id",
		);
	});
});
