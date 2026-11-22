// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseLinePins } from "./standards-pins.js";

describe("lib/standards-pins.js parseLinePins", () => {
	it("gives a bare `:N` pin the path named earlier on its line, never one from a line above", () => {
		const pins = parseLinePins(
			"See `scripts/a.js:3` and `:5`.\nThen `:7`.",
		).map((p) => [p.line, p.rawPath, p.from]);
		expect(pins).toEqual([
			[1, "scripts/a.js", 3],
			[1, "scripts/a.js", 5],
			[2, "", 7],
		]);
	});
});
