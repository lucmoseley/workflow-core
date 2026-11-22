import fs from "node:fs";
import path from "node:path";
import { MIN_CALLS } from "./round-check.js";

// #1799 guess: any margin past one case's wall time
export const LATER = 60_000;

export function transcriptRecords(start: string) {
	const origin = Date.parse(start);
	let clock = origin;
	const at = () => {
		clock += 1000;
		return new Date(clock).toISOString();
	};
	const user = (content: unknown, extra: Record<string, unknown> = {}) =>
		JSON.stringify({
			type: "user",
			...extra,
			timestamp: at(),
			message: { role: "user", content },
		});
	const stopFeedback = () =>
		user("Stop hook feedback: refused", { isMeta: true });
	const stampAfter = (ms: number) => {
		clock = ms;
	};
	return {
		reset: () => {
			clock = origin;
		},
		stampAfter,
		assistant: (text: string, extra: Record<string, unknown> = {}) =>
			JSON.stringify({
				type: "assistant",
				...extra,
				timestamp: at(),
				message: { role: "assistant", content: [{ type: "text", text }] },
			}),
		founder: (text = "go") => user(text, { origin: { kind: "human" } }),
		toolResult: (content = "ok") =>
			user([{ type: "tool_result", tool_use_id: "t1", content }]),
		notification: () =>
			user(
				"<task-notification>\n<tool-use-id>t1</tool-use-id>\n</task-notification>",
				{ origin: { kind: "task-notification" } },
			),
		stopFeedback,
		buildSiblingBlock: () => {
			stampAfter(Date.now() + LATER);
			return stopFeedback();
		},
		buildSkillBody: () =>
			user([{ type: "text", text: "Base directory for this skill: x" }], {
				isMeta: true,
			}),
	};
}

interface BashCallOptions {
	input?: Record<string, unknown>;
	sessionId?: string;
	timestamp?: string;
	uuid?: string;
	isSidechain?: boolean;
}

export const buildToolCall = (
	name: string,
	input: Record<string, unknown>,
	id = "t1",
	extra: Omit<BashCallOptions, "input"> = {},
) => ({
	type: "assistant",
	...extra,
	message: {
		role: "assistant",
		content: [{ type: "tool_use", id, name, input }],
	},
});

export const buildBashCall = (
	command: string,
	id = "t1",
	{ input = {}, ...extra }: BashCallOptions = {},
) => buildToolCall("Bash", { command, ...input }, id, extra);

export const SUBAGENT_HANDLE = "a2948f95aab9e1692";

export const buildAsyncAgentResult = (id = "t1", handle = SUBAGENT_HANDLE) => ({
	type: "user",
	message: {
		content: [
			{
				type: "tool_result",
				tool_use_id: id,
				content: `Async agent launched successfully.\nagentId: ${handle} (internal ID - do not mention to user.)\nThe agent is working in the background.`,
			},
		],
	},
	toolUseResult: { status: "async_launched", agentId: handle },
});

export const buildInterimNotification = (
	id = "t1",
	handle = SUBAGENT_HANDLE,
) => ({
	type: "user",
	message: {
		role: "user",
		content: `<task-notification>\n<task-id>${handle}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n<summary>Agent "Fix #5274 review findings" is waiting on its own background work</summary>\n<note>This agent stopped with background work of its own still running. It may resume on its own when that work completes or reports, and the same task-id notifies again if it does; the result below may be interim.</note>\n<result>This agent has not reported yet: it is waiting on its own background work and will deliver its report through SubagentHandback when that finishes.\n</result>\n</task-notification>`,
	},
});

export const buildFinalNotification = (handle = SUBAGENT_HANDLE) => ({
	type: "queue-operation",
	operation: "enqueue",
	content: `<task-notification>\n<task-id>${handle}</task-id>\n<status>completed</status>\n<summary>Agent "Fix #5274 review findings" finished</summary>\n<result>This agent's report was delivered to you as a message from "${handle}" (its SubagentHandback call).\n</result>\n</task-notification>`,
});

export const buildHandBack = (handle = SUBAGENT_HANDLE) => ({
	type: "attachment",
	attachment: {
		type: "queued_command",
		prompt: `<agent-message from="${handle}">\n[Subagent hand-back] The report follows:\n  All done.\n</agent-message>`,
	},
});

export const researchCalls = (n: number = MIN_CALLS) =>
	Array.from({ length: n }, (_, i) => buildBashCall("ls", `t-research-${i}`));

export const writeTranscript = (file: string, ...lines: string[]) =>
	fs.writeFileSync(file, `${lines.join("\n")}\n`);

export function failOpenLog(config: string): string {
	const found: string[] = [];
	const walk = (at: string) => {
		for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
			const full = path.join(at, entry.name);
			if (entry.isDirectory()) walk(full);
			else found.push(fs.readFileSync(full, "utf8"));
		}
	};
	if (fs.existsSync(config)) walk(config);
	return found.join("");
}
