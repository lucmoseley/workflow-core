// @vitest-environment node
/*
 * lib/regex-group.js's contract (#1341): the group's string when it took part,
 * a thrown error naming the group and the pattern when it did not — never
 * `undefined`, which is the silent run-on the helper exists to stop.
 * In-process over real `exec` results, since the helper is a pure function and
 * a hand-built match would not prove the engine leaves a group `undefined`.
 */

import { describe, expect, it } from "vitest";
import { requiredGroup } from "./regex-group.js";

describe("requiredGroup", () => {
	it("returns the string a participating group matched", () => {
		const re = /^(\w+)=(\d+)$/;
		const m = re.exec("retries=3");
		if (!m) throw new Error("fixture did not match");

		expect(requiredGroup(m, 1, re)).toBe("retries");
		expect(requiredGroup(m, 2, re)).toBe("3");
	});

	it("returns an empty string a group matched, which is not absence", () => {
		const re = /^(\w*)=/;
		const m = re.exec("=3");
		if (!m) throw new Error("fixture did not match");

		expect(requiredGroup(m, 1, re)).toBe("");
	});

	it("throws naming the group and the pattern when the group did not participate", () => {
		const re = /^(a)|(b)$/;
		const m = re.exec("b");
		if (!m) throw new Error("fixture did not match");

		let thrown: unknown;
		try {
			requiredGroup(m, 1, re);
		} catch (e) {
			thrown = e;
		}

		expect(thrown).toBeInstanceOf(Error);
		const err = thrown as Error & { group: number; pattern: string };
		expect(err.name).toBe("RegexGroupMissingError");
		expect(err.message).toContain("group 1");
		expect(err.message).toContain(re.source);
		expect(err.group).toBe(1);
		expect(err.pattern).toBe(re.source);
	});

	it("throws for a group number past the pattern's last group, naming the group number", () => {
		const re = /^(\w+)$/;
		const m = re.exec("x");
		if (!m) throw new Error("fixture did not match");

		expect(() => requiredGroup(m, 2, re)).toThrow(/group 2/);
	});
});
