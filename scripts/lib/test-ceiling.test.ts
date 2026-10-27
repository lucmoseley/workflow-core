// @vitest-environment node
/*
 * Pins that the worker running this file carries WORKER_HEAP_MB, not the
 * heap NODE_OPTIONS hands its launcher: 2048 under the npm scripts, 4096
 * under ~/.bashrc (#3164). It reads the live worker's V8 limit rather than
 * the config, because only the limit shows that `execArgv` reached the fork
 * and beat NODE_OPTIONS. Lose it and a test that allocates without yielding
 * grows until earlyoom kills whatever ranks highest, as in #3112.
 */

import v8 from "node:v8";
import { describe, expect, it } from "vitest";
import { WORKER_HEAP_MB } from "./test-ceiling";

describe("the fork worker's heap cap (#3164)", () => {
	it("is WORKER_HEAP_MB, whatever NODE_OPTIONS the run inherited", () => {
		/* V8 adds a young generation to the old-space cap. Twice the cap is no
		 * measured bound, only one an inherited 2048 or 4096 cannot pass
		 * under. */
		const limitMb = v8.getHeapStatistics().heap_size_limit / 2 ** 20;
		expect(limitMb).toBeGreaterThanOrEqual(WORKER_HEAP_MB);
		expect(limitMb).toBeLessThan(2 * WORKER_HEAP_MB);
	});
});
