// @vitest-environment node

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { readSubagentLogState } = createRequire(__filename)(
	"./subagent-log-state.js",
);

let dir: string;
let log: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "subagent-log-state-"));
	log = join(dir, "agent-a1.jsonl");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const assistant = (content: unknown[], stopReason: string | null) => ({
	type: "assistant",
	message: { role: "assistant", content, stop_reason: stopReason },
});
const user = (content: unknown) => ({
	type: "user",
	message: { role: "user", content },
});
const toolUse = { type: "tool_use", id: "t1", name: "Bash", input: {} };
const toolResult = { type: "tool_result", tool_use_id: "t1", content: "ok" };
const attachment = { type: "attachment", attachment: { type: "x" } };

const writeLog = (...rows: unknown[]) =>
	writeFileSync(
		log,
		rows
			.map((r) => (typeof r === "string" ? r : `${JSON.stringify(r)}\n`))
			.join(""),
	);

describe("a call in flight", () => {
	it.each([
		["a tool call with no result yet", [assistant([toolUse], "tool_use")]],
		[
			"the thinking block of a tool-calling turn",
			[assistant([{ type: "thinking", thinking: "" }], "tool_use")],
		],
		[
			"a tool result the model has not answered",
			[assistant([toolUse], "tool_use"), user([toolResult])],
		],
		["the prompt, before any reply", [user("do the work")]],
		[
			"a tool call followed by a torn line mid-append",
			[assistant([toolUse], "tool_use"), '{"type":"user","mess'],
		],
		[
			"an API request with no reply",
			[user([toolResult]), { type: "api-request" }],
		],
		[
			"a tool result followed only by non-turn records",
			[user([toolResult]), attachment, { type: "api-request-blob" }],
		],
	])("reads %s as in flight", (_name, rows) => {
		writeLog(...rows);
		expect(readSubagentLogState(log)).toEqual({ state: "in-flight" });
	});
});

describe("an agent that stopped", () => {
	it("reads a turn ended with no tool call as stopped", () => {
		writeLog(
			user([toolResult]),
			assistant([{ type: "text", text: "done" }], "end_turn"),
		);
		expect(readSubagentLogState(log)).toEqual({ state: "stopped" });
	});

	it("reads an interrupted agent as stopped", () => {
		writeLog(
			assistant([{ type: "thinking", thinking: "" }], "tool_use"),
			user([{ type: "text", text: "[Request interrupted by user]" }]),
		);
		expect(readSubagentLogState(log)).toEqual({ state: "stopped" });
	});

	it("reads an agent its meta file marks finished as stopped, though its log ends on a tool result", () => {
		writeLog(assistant([toolUse], "tool_use"), user([toolResult]));
		writeFileSync(join(dir, "agent-a1.meta.json"), '{"finished":true}');
		expect(readSubagentLogState(log)).toEqual({ state: "stopped" });
	});

	const handback = {
		type: "tool_use",
		id: "h1",
		name: "SubagentHandback",
		input: { message: "report" },
	};
	const handbackResult = {
		type: "tool_result",
		tool_use_id: "h1",
		content: "Report delivered to your caller.",
	};

	it.each([
		["its SubagentHandback call", [assistant([handback], "tool_use")]],
		[
			"the result of its SubagentHandback call",
			[assistant([handback], "tool_use"), user([handbackResult])],
		],
	])(
		"reads a log ending on %s as stopped, with no meta file (#5496)",
		(_name, rows) => {
			writeLog(user([toolResult]), ...rows);
			expect(readSubagentLogState(log)).toEqual({ state: "stopped" });
		},
	);

	it("reads a later tool call's result as in flight, a handback before it notwithstanding", () => {
		writeLog(
			assistant([handback], "tool_use"),
			user([handbackResult]),
			assistant([toolUse], "tool_use"),
			user([toolResult]),
		);
		expect(readSubagentLogState(log).state).toBe("in-flight");
	});

	it("finds the meta file beside the log a launch result's symlink names", () => {
		writeLog(user([toolResult]));
		writeFileSync(join(dir, "agent-a1.meta.json"), '{"finished":true}');
		mkdirSync(join(dir, "tasks"));
		const link = join(dir, "tasks", "a1.output");
		symlinkSync(log, link);
		expect(readSubagentLogState(link)).toEqual({ state: "stopped" });
	});

	it("ignores a meta file that is unfinished or malformed", () => {
		writeLog(user([toolResult]));
		const meta = join(dir, "agent-a1.meta.json");
		writeFileSync(meta, '{"agentType":"x"}');
		expect(readSubagentLogState(log).state).toBe("in-flight");
		writeFileSync(meta, "{not json");
		expect(readSubagentLogState(log).state).toBe("in-flight");
	});
});

describe("a log that will not read", () => {
	it("is unread where missing, saying so", () => {
		expect(readSubagentLogState(log)).toEqual({
			state: "unread",
			why: `${log} does not exist`,
		});
	});

	it("is unread where it holds no turn record", () => {
		writeFileSync(log, `not json\n${JSON.stringify(attachment)}\n`);
		expect(readSubagentLogState(log)).toEqual({
			state: "unread",
			why: `${log} holds no turn record`,
		});
	});

	it("is unread, never a throw, where the path is a directory", () => {
		expect(readSubagentLogState(dir)).toMatchObject({
			state: "unread",
			why: expect.stringContaining(`cannot read ${dir}`),
		});
	});
});
