// @vitest-environment node

import { describe, expect, it } from "vitest";
import { sleepSync } from "./sleep-sync.js";

describe("sleepSync — a synchronous floor", () => {
	it("blocks for at least the milliseconds asked", () => {
		const ms = 30;
		const started = performance.now();
		sleepSync(ms);
		expect(performance.now() - started).toBeGreaterThanOrEqual(ms - 1);
	});

	it("returns synchronously, handing back nothing to await", () => {
		expect(sleepSync(0)).toBeUndefined();
	});
});
