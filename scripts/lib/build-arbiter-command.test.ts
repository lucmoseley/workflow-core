// @vitest-environment node
/*
 * Every guard's recovery line prints through the tag (#3990), so a loosened case
 * hands a session a command its shell splits.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildArbiterCommand } from "./build-arbiter-command.js";

describe("buildArbiterCommand", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("prints a verb with no word", () => {
		expect(buildArbiterCommand`list --all`).toBe(
			"node scripts/session-arbiter.js list --all",
		);
	});

	it("leaves a safe word bare", () => {
		expect(buildArbiterCommand`release ${"docs/a.md"}`).toBe(
			"node scripts/session-arbiter.js release docs/a.md",
		);
	});

	it("quotes a word holding a space, a quote or a #", () => {
		expect(buildArbiterCommand`wait ${"docs/it's a.md"}`).toBe(
			"node scripts/session-arbiter.js wait 'docs/it'\\''s a.md'",
		);
		expect(buildArbiterCommand`release ${"docs/doc-map.md#B1"}`).toBe(
			"node scripts/session-arbiter.js release 'docs/doc-map.md#B1'",
		);
	});

	it("keeps fixed text and placeholders round the word as written", () => {
		expect(buildArbiterCommand`debt own ${"a b"} <issue> "<one line>"`).toBe(
			`node scripts/session-arbiter.js debt own 'a b' <issue> "<one line>"`,
		);
	});

	it("prints a number as its digits", () => {
		expect(buildArbiterCommand`release-issue ${3990}`).toBe(
			"node scripts/session-arbiter.js release-issue 3990",
		);
	});

	it("quotes each word of an array on its own", () => {
		expect(buildArbiterCommand`release-committed ${["a.md", "b c.md"]}`).toBe(
			"node scripts/session-arbiter.js release-committed a.md 'b c.md'",
		);
	});

	/* No package.json at the root is what an install looks like (script-path.js). */
	it("spells the arbiter at the plugin root in an install", () => {
		vi.stubEnv("WFC_SCRIPT_ROOT", "/plugin/cache/core");
		expect(buildArbiterCommand`list --all`).toBe(
			"node /plugin/cache/core/scripts/session-arbiter.js list --all",
		);
	});
});
