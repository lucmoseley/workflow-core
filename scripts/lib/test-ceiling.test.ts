// @vitest-environment node

import v8 from "node:v8";
import { describe, expect, it } from "vitest";
import { WORKER_HEAP_MB } from "./test-ceiling";

describe("the fork worker's heap cap (#3164)", () => {
	it("is WORKER_HEAP_MB, whatever NODE_OPTIONS the run inherited", () => {
		const limitMb = v8.getHeapStatistics().heap_size_limit / 2 ** 20;
		expect(limitMb).toBeGreaterThanOrEqual(WORKER_HEAP_MB);
		expect(limitMb).toBeLessThan(2 * WORKER_HEAP_MB);
	});
});
