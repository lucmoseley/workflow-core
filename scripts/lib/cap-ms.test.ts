// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { capMs } from "./cap-ms.js";

describe("capMs", () => {
	it("takes a positive knob over the fallback", () => {
		vi.stubEnv("WFC_TEST_CAP_MS", "30000");
		expect(capMs("WFC_TEST_CAP_MS", 6000)).toBe(30_000);
	});

	it.each(["", "0", "-1", "soon", "Infinity"])(
		"keeps the fallback for %j, so a garbled knob never disables the ceiling",
		(value) => {
			vi.stubEnv("WFC_TEST_CAP_MS", value);
			expect(capMs("WFC_TEST_CAP_MS", 6000)).toBe(6000);
		},
	);
});
