// @vitest-environment node
/*
 * Pins the tab tally and the launcher's closing report for a Chrome child
 * (#4847). The rows are hand-built in the extension's own wording
 * (lib/chrome-rows-fake.ts), since no Chrome runs under test: where the
 * extension rewords a result, these still pass and only a live run shows it.
 * Loosening one lets a child leave tabs in the founder's tab strip unnamed.
 */
import { describe, expect, it } from "vitest";
import {
	CHROME_STANDING_LINES,
	chromeOutcome,
	createTabTally,
} from "./chrome-child.js";
import { buildTabContext, buildToolResultRow } from "./chrome-rows-fake";

const NEW_TAB = { tabId: 1, title: "New tab", url: "chrome://newtab/" };
const CONTEXT = buildTabContext(
	[1, "chrome://newtab/", "New tab"],
	[2, "https://example.com/a?b=(c)", 'Say "hi" (now)'],
);

const left = (...rows: unknown[]) => {
	const tally = createTabTally();
	for (const row of rows) tally.read(row);
	return tally.left();
};

describe("createTabTally", () => {
	it("holds the tabs the newest Tab Context block lists, quotes and brackets in a title or URL kept", () => {
		expect(
			left(buildToolResultRow("Created new tab. Tab ID: 2", CONTEXT)),
		).toEqual([
			NEW_TAB,
			{
				tabId: 2,
				title: 'Say "hi" (now)',
				url: "https://example.com/a?b=(c)",
			},
		]);
	});

	it("drops a closed tab, and every tab once the group is gone", () => {
		expect(
			left(
				buildToolResultRow(CONTEXT),
				buildToolResultRow("Closed tab 2. 1 tab(s) remain."),
			),
		).toEqual([NEW_TAB]);
		expect(
			left(
				buildToolResultRow(CONTEXT),
				buildToolResultRow(
					"Closed tab 2. Group is now empty (auto-removed).",
					"\n\nTab Context:\n- Available tabs:\n",
				),
			),
		).toEqual([]);
	});

	it("reads a batch's closes and creates off its lines, where a failed batch lists no tabs", () => {
		expect(
			left(
				buildToolResultRow(CONTEXT),
				buildToolResultRow(
					"[tabs_close_mcp] Closed tab 2. 1 tab(s) remain.\n[tabs_create_mcp] Created new tab. Tab ID: 3\nactions[2] (find) failed (2 completed, 1 remaining)",
				),
			),
		).toEqual([NEW_TAB, { tabId: 3, title: "", url: "" }]);
	});

	it("keeps the tabs of a group the session was cut off from, beside its new group's", () => {
		expect(
			left(
				buildToolResultRow(buildTabContext([1, "chrome://newtab/", "New tab"])),
				buildToolResultRow(
					"This session has no tab group of its own. Any tabs opened earlier in this conversation may still be open in Chrome, in a group this session cannot see or control. Use createIfEmpty: true to create this session's group.",
				),
				buildToolResultRow(buildTabContext([9, "https://example.com/"])),
			),
		).toEqual([
			NEW_TAB,
			{ tabId: 9, title: "A page", url: "https://example.com/" },
		]);
	});

	it("keeps its reading across a result that lists no tabs", () => {
		expect(
			left(
				buildToolResultRow(CONTEXT),
				buildToolResultRow("Navigated to https://example.com/"),
			),
		).toHaveLength(2);
	});

	it("reads a result whose content is one string", () => {
		expect(
			left({
				type: "user",
				message: { content: [{ type: "tool_result", content: CONTEXT }] },
			}),
		).toHaveLength(2);
	});

	it("reads no tab list out of page text or the assistant's own words", () => {
		expect(
			left(
				buildToolResultRow(`Page text: ${CONTEXT}`),
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

describe("chromeOutcome", () => {
	const ended = { left: [], status: 0, signal: null, limitMs: undefined };
	const result = { type: "result", subtype: "success" };

	it("prints the result row with no tab left, saying nothing, at the child's status", () => {
		expect(chromeOutcome({ ...ended, result, status: 3 })).toEqual({
			stdout: '{"type":"result","subtype":"success","tabsLeftOpen":[]}\n',
			stderr: "",
			exit: 3,
		});
	});

	it("names each tab left, in the row and on stderr", () => {
		const end = chromeOutcome({ ...ended, result, left: [NEW_TAB] });
		expect(JSON.parse(end.stdout).tabsLeftOpen).toEqual([NEW_TAB]);
		expect(end.stderr).toBe(
			"claude-child: the child left 1 tab(s) open in its Claude tab group: 1 (chrome://newtab/)\n",
		);
		expect(end.exit).toBe(0);
	});

	it.each([
		[
			"a child killed at the limit",
			{ status: null, signal: "SIGTERM", limitMs: 1500 },
			"claude-child: the child was killed at its 1500 ms limit.\n",
		],
		[
			"a child killed from outside",
			{ status: null, signal: "SIGKILL" },
			"claude-child: the child was killed by SIGKILL.\n",
		],
		[
			"a child that ended clean with no result row",
			{},
			"claude-child: the child ended with no result row.\n",
		],
	])("fails %s, saying which", (_, over, stderr) => {
		expect(chromeOutcome({ ...ended, result: undefined, ...over })).toEqual({
			stdout: "",
			stderr,
			exit: 1,
		});
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
