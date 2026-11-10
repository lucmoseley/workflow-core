// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CHROME_STANDING_LINES, createTabTally } from "./chrome-child.js";

const toolResult = (content: unknown) => ({
	type: "user",
	message: { content: [{ type: "tool_result", content }] },
});
const texts = (...parts: string[]) =>
	toolResult(parts.map((text) => ({ type: "text", text })));
const CONTEXT =
	'\n\nTab Context:\n- Executed on tabId: 2\n- Available tabs:\n  • tabId 1: "New tab" ("chrome://newtab/")\n  • tabId 2: "Say "hi" (now)" ("https://example.com/a?b=(c)")';

const left = (...rows: unknown[]) => {
	const tally = createTabTally();
	for (const row of rows) tally.read(row);
	return tally.left();
};

describe("createTabTally", () => {
	it("holds the tabs the newest Tab Context block lists, quotes and brackets in a title or URL kept", () => {
		expect(left(texts("Created new tab. Tab ID: 2", CONTEXT))).toEqual([
			{ tabId: 1, title: "New tab", url: "chrome://newtab/" },
			{
				tabId: 2,
				title: 'Say "hi" (now)',
				url: "https://example.com/a?b=(c)",
			},
		]);
	});

	it("drops a closed tab, and every tab once the group is gone", () => {
		expect(
			left(texts(CONTEXT), texts("Closed tab 2. 1 tab(s) remain.")),
		).toEqual([{ tabId: 1, title: "New tab", url: "chrome://newtab/" }]);
		expect(
			left(
				texts(CONTEXT),
				texts(
					"Closed tab 2. Group is now empty (auto-removed).",
					"\n\nTab Context:\n- Available tabs:\n",
				),
			),
		).toEqual([]);
	});

	it("keeps its reading across a result that lists no tabs", () => {
		expect(
			left(texts(CONTEXT), texts("Navigated to https://example.com/")),
		).toHaveLength(2);
	});

	it("reads a result whose content is one string", () => {
		expect(left(toolResult(CONTEXT))).toHaveLength(2);
	});

	it("reads no tab list out of page text or the assistant's own words", () => {
		expect(
			left(
				texts(`Page text: ${CONTEXT}`),
				{
					type: "assistant",
					message: { content: [{ type: "text", text: CONTEXT }] },
				},
				null,
				"a string",
				{ type: "user", message: { content: "typed text" } },
			),
		).toEqual([]);
	});
});

it("tells the child to close its own tabs and no other", () => {
	expect(CHROME_STANDING_LINES).toContain(
		"close every tab in your own tab group",
	);
	expect(CHROME_STANDING_LINES).toContain(
		"Never close a tab or window outside your own tab group.",
	);
});
