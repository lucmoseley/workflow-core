// @vitest-environment node
/*
 * round-marker.test.ts — the one spelling of the `❓ **Qn**` marker, pinned.
 *
 * The spelling is shared (#218), so what needs pinning is the spelling itself:
 * the anchoring, the optional space and the digits. The cases run in-process on
 * plain strings, plus a read of both guards' source to show neither declares a
 * regex of its own. Both are Stop hooks in `.claude/settings.json`. Loosen a
 * case here and a turn silently changes hands between guard-priced-options.js
 * and guard-jev-advisory.js — read by both, or by neither.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const { Q_MARKER, roundNumber, hasRoundMarker } = createRequire(__filename)(
	"./round-marker.js",
) as {
	Q_MARKER: RegExp;
	roundNumber: (line: string) => string | null;
	hasRoundMarker: (message: string) => boolean;
};

describe("roundNumber", () => {
	it("reads the number off a marker at the start of the line", () => {
		expect(roundNumber("❓ **Q1** Which way?")).toBe("1");
	});

	it("takes every digit, so rounds past nine are not truncated", () => {
		expect(roundNumber("❓ **Q12** Which way?")).toBe("12");
	});

	it("takes the marker with no space after the ornament", () => {
		expect(roundNumber("❓**Q1** Which way?")).toBe("1");
	});

	it("is anchored, so a marker mid-sentence opens nothing", () => {
		expect(roundNumber("a line mentioning ❓ **Q1** in passing")).toBeNull();
	});

	it("is anchored past leading whitespace too, so an indented marker opens nothing", () => {
		expect(roundNumber("  ❓ **Q1** indented")).toBeNull();
	});

	it("needs the ornament, so bold alone opens nothing", () => {
		expect(roundNumber("**Q1** no marker")).toBeNull();
	});

	it("needs a number, so a bare Q opens nothing", () => {
		expect(roundNumber("❓ **Q** no number")).toBeNull();
	});
});

describe("hasRoundMarker", () => {
	it("finds a marker on a line below the first", () => {
		expect(hasRoundMarker("Preamble.\n\n❓ **Q1** Which way?")).toBe(true);
	});

	it("says no where no line opens a round", () => {
		expect(hasRoundMarker("Two ways to take this. Rebuild, or leave it.")).toBe(
			false,
		);
	});

	it("says no for an empty message", () => {
		expect(hasRoundMarker("")).toBe(false);
	});
});

describe("Q_MARKER", () => {
	it("is stateless, so repeated tests on the same line agree", () => {
		expect(Q_MARKER.global).toBe(false);
		expect([
			Q_MARKER.test("❓ **Q1** a"),
			Q_MARKER.test("❓ **Q1** a"),
		]).toEqual([true, true]);
	});
});

describe("the guards that share it", () => {
	/* AC1 of #218: neither guard has grown a second spelling back.
	 *
	 * The paths are written out rather than looped over, so that
	 * scripts/generate-test-read-edges.js — a lexical extractor — records both
	 * guards as read here and test:changed selects this file when either one
	 * changes. */
	const declaresItsOwn = (file: string) =>
		fs
			.readFileSync(file, "utf8")
			.split("\n")
			.filter((line) => /^const\s+\w+\s*=\s*\/\^(?:\\u2753|\u2753)/.test(line));

	it("guard-priced-options.js declares no round-marker regex of its own", () => {
		expect(
			declaresItsOwn(path.join(__dirname, "..", "guard-priced-options.js")),
		).toEqual([]);
	});

	it("guard-jev-advisory.js declares no round-marker regex of its own", () => {
		expect(
			declaresItsOwn(path.join(__dirname, "..", "guard-jev-advisory.js")),
		).toEqual([]);
	});
});
