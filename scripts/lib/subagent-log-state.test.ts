// @vitest-environment node
/*
 * subagent-log-state.test.ts — reading a subagent's log for a call in flight
 * (#5421). Each record shape is one a real log ends on (the module header's
 * measurement); a reading that calls a live agent stopped gets it abandoned,
 * and one that calls a finished agent live holds its watcher to the ceiling.
 */

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

const { subagentLogState } = createRequire(__filename)(
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
	writeFileSync(log, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));

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
			"an API request with no reply",
			[user([toolResult]), { type: "api-request" }],
		],
		[
			"a tool result followed only by non-turn records",
			[user([toolResult]), attachment, { type: "api-request-blob" }],
		],
	])("reads %s as in flight", (_name, rows) => {
		writeLog(...rows);
		expect(subagentLogState(log)).toEqual({ state: "in-flight" });
	});
});

describe("an agent that stopped", () => {
	it("reads a turn ended with no tool call as stopped", () => {
		writeLog(
			user([toolResult]),
			assistant([{ type: "text", text: "done" }], "end_turn"),
		);
		expect(subagentLogState(log)).toEqual({ state: "stopped" });
	});

	it("reads an interrupted agent as stopped", () => {
		writeLog(
			assistant([{ type: "thinking", thinking: "" }], "tool_use"),
			user([{ type: "text", text: "[Request interrupted by user]" }]),
		);
		expect(subagentLogState(log)).toEqual({ state: "stopped" });
	});

	it("reads an agent its meta file marks finished as stopped, though its log ends on a tool result", () => {
		writeLog(assistant([toolUse], "tool_use"), user([toolResult]));
		writeFileSync(join(dir, "agent-a1.meta.json"), '{"finished":true}');
		expect(subagentLogState(log)).toEqual({ state: "stopped" });
	});

	it("finds the meta file beside the log a launch result's symlink names", () => {
		writeLog(user([toolResult]));
		writeFileSync(join(dir, "agent-a1.meta.json"), '{"finished":true}');
		mkdirSync(join(dir, "tasks"));
		const link = join(dir, "tasks", "a1.output");
		symlinkSync(log, link);
		expect(subagentLogState(link)).toEqual({ state: "stopped" });
	});

	it("ignores a meta file that is unfinished or malformed", () => {
		writeLog(user([toolResult]));
		const meta = join(dir, "agent-a1.meta.json");
		writeFileSync(meta, '{"agentType":"x"}');
		expect(subagentLogState(log).state).toBe("in-flight");
		writeFileSync(meta, "{not json");
		expect(subagentLogState(log).state).toBe("in-flight");
	});
});

describe("a log that will not read", () => {
	it("is unread where missing, saying so", () => {
		expect(subagentLogState(log)).toEqual({
			state: "unread",
			why: `${log} does not exist`,
		});
	});

	it("is unread where it holds no turn record", () => {
		writeFileSync(log, `not json\n${JSON.stringify(attachment)}\n`);
		expect(subagentLogState(log)).toEqual({
			state: "unread",
			why: `${log} holds no turn record`,
		});
	});

	it("is unread, never a throw, where the path is a directory", () => {
		expect(subagentLogState(dir)).toMatchObject({
			state: "unread",
			why: expect.stringContaining(`cannot read ${dir}`),
		});
	});
});
