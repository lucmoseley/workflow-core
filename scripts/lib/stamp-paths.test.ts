/*
 * stamp-paths.test.ts — the stamp allowlist holds exactly the ruled stamps
 * (mantahostels#422, mantahostels#1281), not docs/reference-roadmap.html (mantahostels#1074).
 */

import { describe, expect, it } from "vitest";

const { STAMP_PATHS, withoutStamps } = require("./stamp-paths.js");

describe("the stamp allowlist", () => {
	it("holds exactly the ruled stamps, not docs/reference-roadmap.html", () => {
		expect(STAMP_PATHS).toEqual(["docs/doc-map.md", "CLAUDE.md"]);
	});

	it("leaves a write-set's substrate paths once the stamps are taken out", () => {
		expect(
			withoutStamps(["CLAUDE.md", "scripts/a.js", "docs/doc-map.md"]),
		).toEqual(["scripts/a.js"]);
	});
});
