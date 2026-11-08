/*
 * Which prompt a parked session wakes to, by the block its park marker names
 * (#3949). Text rather than a guard run, as guard-inventory.test.ts drives the
 * prompts through the guards. A wrong pick tells a session on a round to repeat
 * a tool call, or one on a permission to post nothing and be refused for it.
 */
import { describe, expect, it } from "vitest";
import {
	BOOT_PROMPT,
	BOOT_UNREAD_PROMPT,
	hasNothingToRepeat,
	parkedPromptOf,
} from "./loop-prompts.js";

describe("a parked session's resume, by the block its marker names (#3949)", () => {
	it.each(["API_ERROR", "LIMIT"])("%s has nothing to repeat", (cause) => {
		expect(hasNothingToRepeat(cause)).toBe(true);
		expect(parkedPromptOf(cause)).toContain("continue your task");
	});

	it("a permission park is told to repeat its call", () => {
		expect(hasNothingToRepeat("PERMISSION")).toBe(false);
		expect(parkedPromptOf("PERMISSION")).toContain(
			"Repeat the tool call that raised it",
		);
	});

	it.each(["QUESTION", "a cause no prompt knows", undefined])(
		"%s points at what it left standing",
		(cause) => {
			expect(hasNothingToRepeat(cause)).toBe(false);
			expect(parkedPromptOf(cause)).toContain("the founder may be back");
			expect(parkedPromptOf(cause)).not.toContain("Repeat the tool call");
		},
	);
});

describe("a session a restart killed on a block the loop could not read (#3980)", () => {
	it("is asked what it waits on, not told to continue", () => {
		expect(BOOT_UNREAD_PROMPT).toContain("you may be waiting on the founder");
		expect(BOOT_UNREAD_PROMPT).not.toContain("then continue your task");
		expect(BOOT_UNREAD_PROMPT).toContain(
			"Where you parked on a question round or an act you handed him, make no tool call",
		);
	});
});

describe("a session a restart killed mid-work (#4098)", () => {
	it("re-claims its issues and stands down where a twin holds them", () => {
		expect(BOOT_PROMPT).toContain(
			"`node scripts/claim-issue.js <n>` on each issue you hold",
		);
		expect(BOOT_PROMPT).toContain("where it refuses on a live holder");
	});

	it("asks one killed on an unread block to re-claim only where it continues", () => {
		expect(BOOT_UNREAD_PROMPT).toContain(
			"Where you continue, first re-run `node scripts/claim-issue.js <n>`",
		);
	});
});
