export const STOP_AT = "2026-11-17T02:47:07.916Z";

export const toolCallRow = (timestamp = "2026-11-17T02:46:33.802Z") => ({
	type: "assistant",
	isSidechain: false,
	uuid: "a1",
	timestamp,
	message: {
		model: "claude-opus-5-5",
		role: "assistant",
		content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }],
	},
});

export const replyRow = (
	text: string,
	timestamp = "2026-11-17T02:46:33.802Z",
) => ({
	type: "assistant",
	isSidechain: false,
	uuid: "a2",
	timestamp,
	message: {
		model: "claude-opus-5-5",
		role: "assistant",
		content: [{ type: "text", text }],
	},
});

export const toolResultRow = (timestamp = "2026-11-17T02:46:35.662Z") => ({
	type: "user",
	isSidechain: false,
	uuid: "u1",
	timestamp,
	message: {
		role: "user",
		content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "" }],
	},
});

export const apiRequestRow = (timestamp = "2026-11-17T02:46:35.881Z") => ({
	type: "api-request",
	timestamp,
});

export const syntheticRow = (
	timestamp = STOP_AT,
	text = "No response requested.",
	over: Record<string, unknown> = {},
) => ({
	type: "assistant",
	isSidechain: false,
	uuid: "s1",
	timestamp,
	isApiErrorMessage: false,
	error: null,
	message: {
		model: "<synthetic>",
		role: "assistant",
		stop_reason: "stop_sequence",
		content: [{ type: "text", text }],
	},
	...over,
});

export const founderRow = (
	text = "Why was this session stopped?",
	timestamp = "2026-11-17T02:47:13.683Z",
) => ({
	type: "user",
	isSidechain: false,
	uuid: "u2",
	timestamp,
	origin: { kind: "human" },
	promptSource: "typed",
	message: { role: "user", content: text },
});

export const stoppedRows = (at = STOP_AT) => [
	toolCallRow(),
	toolResultRow(),
	apiRequestRow(),
	syntheticRow(at),
];

export const doneJob = (over: Record<string, unknown> = {}) => ({
	state: "done",
	detail: "done",
	tempo: "idle",
	sessionId: "5e5e5e5e-0000-4000-8000-000000000001",
	name: "Implement 9001: a ticket",
	intent: "/implement 9001",
	cliVersion: "2.1.326",
	...over,
});
