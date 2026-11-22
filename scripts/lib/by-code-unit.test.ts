// @vitest-environment node

import { describe, expect, it } from "vitest";
import { byCodeUnit } from "./by-code-unit.js";

describe("byCodeUnit", () => {
	it("returns -1, 1 and 0 for before, after and level", () => {
		expect(byCodeUnit("a", "b")).toBe(-1);
		expect(byCodeUnit("b", "a")).toBe(1);
		expect(byCodeUnit("a", "a")).toBe(0);
	});

	it("sorts upper case ahead of lower, where localeCompare would not", () => {
		expect(["b", "a", "B"].sort(byCodeUnit)).toEqual(["B", "a", "b"]);
	});
});
