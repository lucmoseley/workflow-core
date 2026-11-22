// @vitest-environment node

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
