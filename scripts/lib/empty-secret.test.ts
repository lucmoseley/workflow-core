// @vitest-environment node
/*
 * lib/empty-secret.js's refusal wording (#2554). The hidden-prompt case is
 * read here because no test drives write-secret.js on a real terminal; the
 * piped case runs end to end in write-secret.test.ts. Loosen a case and the
 * founder is told to retype a value no prompt asked for, or handed a line
 * that differs from the one the founder hand-over rule prints.
 */

import { describe, expect, it } from "vitest";
import { emptyWhy } from "./empty-secret.js";
import { hostRoot } from "./host-root.js";
import { ruleText } from "./rule-text.js";

describe("emptyWhy (#2554)", () => {
	it("keeps the Enter wording for a value typed at the hidden prompt", () => {
		expect(emptyWhy("K", "/srv/host", true)).toBe(
			"the value for K is empty. Re-run and type or paste it before Enter.",
		);
	});

	it("names no terminal as the cause for a piped value, ending on the SECRET paragraph's own line", () => {
		const why = emptyWhy("AI_GATEWAY_API_KEY", hostRoot(), false);
		expect(why).toContain("stdin is not a terminal");
		const secretLine = ruleText("founder-handover")
			.split("\n")
			.find((line) => /write-secret\.js AI_GATEWAY_API_KEY$/.test(line));
		expect(secretLine).toBeDefined();
		expect(why.split("\n").at(-1)).toBe(secretLine);
	});
});
