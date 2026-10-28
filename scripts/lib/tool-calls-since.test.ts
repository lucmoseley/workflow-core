// @vitest-environment node
/*
 * tool-calls-since.test.ts — which transcript records read as the founder's
 * message. Loosen it and a refill loop resume restarts the priced-options
 * guard's since-the-founder windows as if he had spoken (#3378).
 */

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const req = createRequire(import.meta.url);
const { isFounderMessage } = req("./tool-calls-since.js");
const { API_PROMPT, IDLE_PROMPT } = req("./loop-prompts.js");

const userRecord = (content: string, origin?: { kind: string }) => ({
	type: "user",
	...(origin ? { origin } : {}),
	message: { role: "user", content },
});

describe("isFounderMessage", () => {
	it.each([
		["API_PROMPT", API_PROMPT],
		["IDLE_PROMPT", IDLE_PROMPT],
	])("skips the loop's %s, with origin human or none", (_name, prompt) => {
		expect(isFounderMessage(userRecord(prompt, { kind: "human" }))).toBe(false);
		expect(isFounderMessage(userRecord(prompt))).toBe(false);
	});

	it("counts the founder's prompt that only quotes the loop's prefix", () => {
		expect(
			isFounderMessage(
				userRecord(`why did it send ${API_PROMPT}`, { kind: "human" }),
			),
		).toBe(true);
	});
});
