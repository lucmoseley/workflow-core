// @vitest-environment node
/*
 * sleep-sync.test.ts — the lower bound the shared pause promises (mantahostels#2986).
 *
 * An upper bound would be a race against scheduler jitter on the capped
 * machine and is deliberately absent.
 *
 * The arbiter's lock and claim retries pause through it between filesystem
 * probes; loosen a case and a retry loop can spin through its budget at once,
 * failing a claim a moment's wait would have won.
 */

import { describe, expect, it } from "vitest";
import { sleepSync } from "./sleep-sync.js";

describe("sleepSync — a synchronous floor", () => {
	it("blocks for at least the milliseconds asked", () => {
		const ms = 30;
		const started = performance.now();
		sleepSync(ms);
		// Two clocks: Atomics.wait times itself and performance.now() is read
		// around it, so the 1 ms grace absorbs their skew.
		// §X9: the subject is a real sleep; a floor, so load only moves it away from failing.
		expect(performance.now() - started).toBeGreaterThanOrEqual(ms - 1);
	});

	it("returns synchronously, handing back nothing to await", () => {
		expect(sleepSync(0)).toBeUndefined();
	});
});
