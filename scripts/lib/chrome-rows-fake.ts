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

export const buildTabContext = (
	...tabs: [tabId: number, url: string, title?: string][]
) =>
	`\n\nTab Context:\n- Available tabs:\n${tabs.map(([id, url, title = "A page"]) => `  • tabId ${id}: "${title}" ("${url}")`).join("\n")}`;
