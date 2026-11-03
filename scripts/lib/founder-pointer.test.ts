// @vitest-environment node
/*
 * What sends the founder away for his steps, and what merely mentions a ticket
 * (#4058). Built on phrases, each taken from a real ending or from the review's probe,
 * because the check is lexical. Loosen it and he is told to go and read an issue;
 * tighten it and an ordinary report costs a re-send.
 */

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { founderPointer } = createRequire(__filename)("./founder-pointer.js");

describe("founderPointer", () => {
	it.each([
		[
			'Then follow the steps in the issue body, under "How to run it".',
			"Then follow the steps in the issue body",
		],
		[
			"- Follow the steps in the issue body.",
			"Follow the steps in the issue body",
		],
		["**Follow the steps on #4006.**", "Follow the steps on #4006"],
		[
			"(A) Apply the two UI steps posted on #3579",
			"Apply the two UI steps posted on #3579",
		],
		["Now follow the steps on `#4006`.", "Now follow the steps on #4006"],
		["Run the steps on #4006.", "Run the steps on #4006"],
		["The steps are on #4006.", "steps are on #4006"],
		["The steps are in the issue body.", "steps are in the issue body"],
		["The issue body has the steps.", "The issue body has the steps"],
		["Please read the ticket.", "Please read the ticket"],
		["See #4006.", "See #4006"],
		["Follow the shorter version above.", "shorter version above"],
		["I've given you the steps.", "I've given you the steps"],
		[
			"1. Tests pass.\n2. CI green.\n\nI've given you the steps.",
			"I've given you the steps",
		],
		["Use the steps I gave earlier.", "steps I gave"],
		["Run the command above.", "command above"],
		["Paste the install line above.", "line above"],
	])("refuses %s", (message, phrase) => {
		expect(founderPointer(message)).toBe(phrase);
	});

	it.each([
		"I record your answer and close #4006.",
		"A failed step gets a new ticket under #3596.",
		"I read the issue body before starting.",
		"I ran the steps above and they passed.",
		"waits on you:\n- #4006 (run the wheel check and send back the result)",
		"#3948 (scrolling for a short pane) is on main.",
		"```\nFollow the steps in the issue body.\n```",
		"~~~\nFollow the steps in the issue body.\n~~~",
		"1. Click the box.\n2. Close the tab.\n\nThose are the steps above.",
		"1. Click.\n2. Close.\n\nThe steps are also on the ticket.",
		"```\nwc3\n```\n\nThe steps above are all of it.",
		"The rows move a page and the view above it stays.",
		"The version above 2.1 fails.",
		"Use #4006 to track it.",
		"Use comments instead of docstrings.",
		"Open the issue form.",
		"Check the status on #4058.",
		"Next: read the ticket's comments and resolve it.",
		"Check the landing status.",
	])("passes %s", (message) => {
		expect(founderPointer(message)).toBeUndefined();
	});
});
