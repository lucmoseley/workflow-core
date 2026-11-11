// @vitest-environment node
/*
 * Tests for registrations.js's hook half: how a `hooks` row's `covers` reads
 * the matcher registered, through core-hooks' `isToolCovered` (#4917).
 *
 * The rows and registrations are literals, because the shapes under test — a
 * wildcard matcher, an absent one, one that will not compile — are ones no
 * adopter's registry holds today. A loosened case lets check-registrations.js
 * report false drift on a wildcard row, or crash on a broken matcher.
 */

import { describe, expect, it } from "vitest";
import { hookFaults } from "./registrations.js";

const reg = (matcher: string | undefined) => ({
	event: "PreToolUse",
	matcher,
	command: "scripts/guard-a.sh",
	timeout: 10,
});

const row = (matcher: string | null) => ({
	event: "PreToolUse",
	id: "scripts/guard-a.sh",
	matcher,
	covers: ["Bash"],
});

describe("hookFaults", () => {
	it('reads "" and "*" as covering every tool', () => {
		for (const matcher of ["", "*"])
			expect(hookFaults([row(matcher)], [reg(matcher)]).drifted).toEqual([]);
	});

	it("reports drift where the registered matcher no longer covers a listed tool", () => {
		const drifted = hookFaults([row("Edit")], [reg("Edit")]).drifted;
		expect(drifted.map((f) => f.message)).toEqual([
			expect.stringContaining(
				"says it covers Bash, and the registered matcher no longer fires on it",
			),
		]);
	});

	it("reads an absent matcher as covering every tool", () => {
		expect(hookFaults([row(null)], [reg(undefined)]).drifted).toEqual([]);
	});

	it("names a registered matcher that will not compile, rather than throwing", () => {
		const { drifted } = hookFaults([row("[")], [reg("[")]);
		expect(drifted.map((f) => f.message)).toEqual([
			expect.stringMatching(
				/says what it covers, and the matcher "\[" is not a valid regular expression/,
			),
		]);
	});
});
