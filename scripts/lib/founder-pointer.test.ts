// @vitest-environment node
/* What sends the founder away for his steps, and what merely mentions a ticket (#4058). */

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { founderPointer } = createRequire(__filename)("./founder-pointer.js");

describe("founderPointer", () => {
	it.each([
		'Then follow the steps in the issue body, under "How to run it".',
		"Follow the steps on #4006.",
		"The steps are on #4006.",
		"The steps are in the issue body.",
		"Please read the ticket.",
		"See #4006.",
		"You can open the issue comment for the walk.",
		"Follow the shorter version above.",
		"I've given you the steps.",
		"Use the steps I gave earlier.",
	])("refuses %s", (message) => {
		expect(founderPointer(message)).toBeTruthy();
	});

	it.each([
		"I record your answer and close #4006.",
		"A failed step gets a new ticket under #3596.",
		"I read the issue body before starting.",
		"waits on you:\n- #4006 (run the wheel check and send back the result)",
		"#3948 (scrolling for a short pane) is on main.",
		"```\nFollow the steps in the issue body.\n```",
		"Run `see #4006` to read it.",
		"1. Click the box.\n2. Close the tab.\n\nThose are the steps above.",
		"The rows move a page and the view above it stays.",
	])("passes %s", (message) => {
		expect(founderPointer(message)).toBeUndefined();
	});
});
