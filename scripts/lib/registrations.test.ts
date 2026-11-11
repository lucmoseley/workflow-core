// @vitest-environment node
/*
 * Tests for registrations.js's hook half: how a `hooks` row's `covers` reads
 * the matcher registered, through core-hooks' `isToolCovered` (#4917).
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
	it('reads "" and "*" as covering every tool, as core-hooks does', () => {
		for (const matcher of ["", "*"])
			expect(hookFaults([row(matcher)], [reg(matcher)]).drifted).toEqual([]);
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
