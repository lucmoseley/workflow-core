/*
 * The rows a Chrome child's stream carries, as the Claude in Chrome extension
 * words them (#4847): what the suites of lib/chrome-child.js and of
 * claude-child.js's Chrome mode feed the tab tally.
 */

/** A stream row carrying one Chrome tool result's text parts. */
export const buildToolResultRow = (...texts: string[]) => ({
	type: "user",
	message: {
		role: "user",
		content: [
			{
				type: "tool_result",
				tool_use_id: "toolu_1",
				content: texts.map((text) => ({ type: "text", text })),
			},
		],
	},
});

/** The `Tab Context:` part closing a tool result, listing `tabs` as the
 * group's own. */
export const buildTabContext = (
	...tabs: [tabId: number, url: string, title?: string][]
) =>
	`\n\nTab Context:\n- Available tabs:\n${tabs.map(([id, url, title = "A page"]) => `  • tabId ${id}: "${title}" ("${url}")`).join("\n")}`;
