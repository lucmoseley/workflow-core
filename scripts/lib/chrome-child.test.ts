// @vitest-environment node
/*
 * Pins the tab tally, the launcher's closing report and the closer's reading
 * of a resume for a Chrome child (#4847, #5385). The rows are hand-built in the extension's own wording
 * (lib/chrome-rows-fake.ts), since no Chrome runs under test: where the
 * extension rewords a result, these still pass and only a live run shows it.
 * Loosening one lets a child leave tabs in the founder's tab strip unnamed.
 */
import { describe, expect, it } from "vitest";
import {
	chromeOutcome,
	chromeStandingLines,
	createCloseReader,
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
	const Session = "0b8e1c2a-0000-4000-8000-000000000000";
	const ended = {
		sessionId: Session,
		left: [],
		held: [],
		status: 0,
		signal: null,
		stopped: false,
		limitMs: undefined,
		killedBy: undefined,
		failed: undefined,
		said: [],
		closeCommand: `claude-child.js chrome-close --session ${Session}`,
	};
	const result = { type: "result", subtype: "success" };
	const LeftOpen = /claude-child: the child left \d+ tab\(s\) open/;
	const line = (out: { stdout: string }) => {
		expect(out.stdout.endsWith("\n")).toBe(true);
		expect(out.stdout.trimEnd().split("\n")).toHaveLength(1);
		return JSON.parse(out.stdout);
	};

	it("prints the result row with no tab left, saying nothing, at the child's status", () => {
		const out = chromeOutcome({ ...ended, result, status: 3 });
		expect(line(out)).toEqual({
			...result,
			sessionId: Session,
			tabsLeftOpen: [],
			heldTab: null,
			notes: [],
		});
		expect(out.stderr).toBe("");
		expect(out.exit).toBe(3);
	});

	it("names each tab left, in the row and on stderr, the note mirrored word for word", () => {
		const out = chromeOutcome({
			...ended,
			result,
			left: [NEW_TAB],
			stopped: true,
		});
		const row = line(out);
		expect(row.tabsLeftOpen).toEqual([NEW_TAB]);
		expect(out.stderr).toMatch(
			/^claude-child: the child left 1 tab\(s\) open in its Claude tab group: 1 \(chrome:\/\/newtab\/\)/,
		);
		expect(out.stderr).toContain(Session);
		expect(row.notes).toEqual([out.stderr.trimEnd()]);
		expect(out.exit).toBe(0);
	});

	it("holds one hand-over tab out of tabsLeftOpen and out of the fault's wording", () => {
		const out = chromeOutcome({
			...ended,
			result,
			held: [NEW_TAB],
			stopped: true,
		});
		const row = line(out);
		expect(row.tabsLeftOpen).toEqual([]);
		expect(row.heldTab).toEqual(NEW_TAB);
		expect(out.stderr).not.toMatch(LeftOpen);
		expect(out.stderr).toContain('"New tab" (chrome://newtab/)');
		expect(out.stderr).toContain(ended.closeCommand);
		expect(out.exit).toBe(0);
	});

	it("says a hand-over leaves one tab where the child held more, still not in the fault's wording", () => {
		const other = { tabId: 2, title: "B", url: "https://example.com/" };
		const out = chromeOutcome({
			...ended,
			result,
			held: [NEW_TAB, other],
			stopped: true,
		});
		expect(out.stderr).toContain("a hand-over leaves one tab");
		expect(out.stderr).not.toMatch(LeftOpen);
		expect(line(out).heldTab).toEqual(other);
	});

	it("fails a stopped child whose result was an error", () => {
		const out = chromeOutcome({
			...ended,
			result: { ...result, subtype: "error_max_turns", is_error: true },
			left: [NEW_TAB],
			stopped: true,
		});
		expect(out.exit).toBe(1);
	});

	it("mirrors what the launcher noted along the way into notes and stderr", () => {
		const out = chromeOutcome({
			...ended,
			result,
			said: ["could not update the child's record (EACCES)."],
		});
		const note = "claude-child: could not update the child's record (EACCES).";
		expect(line(out).notes).toEqual([note]);
		expect(out.stderr).toBe(`${note}\n`);
	});

	it.each([
		[
			"a child that gave no row after its interrupt",
			{ status: null, signal: "SIGTERM", stopped: true, limitMs: 1500 },
			"launcher_time_limit",
			"claude-child: the child gave no result row after its interrupt at its 1500 ms limit, and was stopped.",
		],
		[
			"a child killed from outside",
			{ status: null, signal: "SIGKILL" },
			"launcher_no_result",
			"claude-child: the child was killed by SIGKILL.",
		],
		[
			"a child that ended clean with no result row",
			{},
			"launcher_no_result",
			"claude-child: the child ended with no result row.",
		],
		[
			"a launch that failed before the child ran",
			{ status: null, failed: "the child did not finish (spawn ENOENT)." },
			"launcher_no_result",
			"claude-child: the child did not finish (spawn ENOENT).",
		],
		[
			"a launcher killed by a signal",
			{ status: null, killedBy: "SIGTERM" },
			"launcher_killed",
			`claude-child: the launcher was killed by SIGTERM; a closer resumes session ${Session} to close the child's tabs.`,
		],
	])("fails %s with a launcher row, saying which", (_, over, subtype, note) => {
		const out = chromeOutcome({ ...ended, result: undefined, ...over });
		expect(line(out)).toMatchObject({
			type: "result",
			subtype,
			result: null,
			sessionId: Session,
			notes: [note],
		});
		expect(out.stderr).toBe(`${note}\n`);
		expect(out.exit).toBe(1);
	});
});

describe("createCloseReader", () => {
	const outcome = (...rows: unknown[]) => {
		const reader = createCloseReader();
		for (const row of rows) reader.read(row);
		return reader.outcome();
	};

	it.each([
		[
			"closed, where the last close empties the group",
			[
				buildToolResultRow(CONTEXT),
				buildToolResultRow("Closed tab 2. 1 tab(s) remain."),
				buildToolResultRow("Closed tab 1. Group is now empty (auto-removed)."),
			],
			"closed",
		],
		[
			"closed, where the tab context lists no tab",
			[buildToolResultRow("\n\nTab Context:\n- Available tabs:\n")],
			"closed",
		],
		[
			"gone, where the group no longer exists",
			[
				buildToolResultRow(
					"This session's tab group no longer exists. Use createIfEmpty: true to create a new group.",
				),
			],
			"gone",
		],
		[
			"gone, where the session has no group of its own",
			[
				buildToolResultRow(
					"This session has no tab group of its own. Any tabs opened earlier in this conversation may still be open in Chrome.",
				),
			],
			"gone",
		],
		[
			"not-connected, where the bridge did not answer",
			[buildToolResultRow("Browser extension is not connected.")],
			"not-connected",
		],
		[
			"failed, where tabs are still listed",
			[
				buildToolResultRow(CONTEXT),
				buildToolResultRow("Closed tab 2. 1 tab(s) remain."),
			],
			"failed",
		],
		["failed, where no tool ran", [], "failed"],
	])("reads %s", (_, rows, want) => {
		expect(outcome(...rows)).toBe(want);
	});

	it("reads the model's own words as nothing", () => {
		expect(
			outcome({
				type: "assistant",
				message: { content: [{ type: "text", text: "Group is now empty" }] },
			}),
		).toBe("failed");
	});
});

describe("chromeStandingLines", () => {
	it("tells every child to close its own tabs and no other", () => {
		expect(chromeStandingLines(false)).toContain(
			"close every tab in your own tab group",
		);
		expect(chromeStandingLines(false)).toContain(
			"whatever the task says about leaving a tab open",
		);
		for (const handOver of [false, true])
			expect(chromeStandingLines(handOver)).toContain(
				"Never close a tab or window outside your own tab group.",
			);
	});

	it("tells a hand-over child to leave exactly one tab, every allowed step taken", () => {
		const lines = chromeStandingLines(true);
		expect(lines).toContain("leave exactly one tab open");
		expect(lines).toContain("Take every step you are allowed to take");
		expect(lines).not.toContain("whatever the task says");
	});
});
