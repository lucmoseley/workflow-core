// @vitest-environment node
/*
 * `readPendingTasks` (mantahostels#2487) — the transcript read that tells a live `waiting:` from
 * a stalled one, and names each launch still out (#1201).
 *
 * In-process, over JSONL transcripts written to a temp dir in the record shapes
 * copied from real ones, since the transcript is the only signal the reader has.
 *
 * Its readers are Stop hooks in `.claude/settings.json` —
 * `guard-priced-options.js`, `guard-uncommitted-work.js` and
 * `guard-session-ceiling.js` — so a loosened case either lets a session end on
 * a `waiting:` nothing will wake, or refuses a true one.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBashCall } from "./transcript-testkit";

// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const { readPendingTasks }: any =
	createRequire(__filename)("./pending-tasks.js");

let dir: string;
let file: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pending-tasks-"));
	file = path.join(dir, "transcript.jsonl");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** An assistant turn holding one tool call, the shape the transcript writes. */
const toolUse = (id: string, name: string, input: unknown = {}) =>
	JSON.stringify({
		type: "assistant",
		message: { content: [{ type: "tool_use", id, name, input }] },
	});
const bash = (command: string, id: string, input = {}) =>
	JSON.stringify(buildBashCall(command, id, { input }));

/**
 * The settlement record, copied from a real transcript: the notification
 * arrives inside a `queue-operation` whose `content` is the whole block as one
 * escaped string.
 */
const settlement = (id: string, status = "completed") =>
	JSON.stringify({
		type: "queue-operation",
		operation: "enqueue",
		content: `<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n</task-notification>`,
	});

/**
 * A user turn holding one tool call's result, with the structured
 * `toolUseResult` the harness writes beside it where one is given.
 */
const toolResult = (
	id: string,
	body: string,
	{
		error = false,
		toolUseResult,
	}: { error?: boolean; toolUseResult?: object } = {},
) =>
	JSON.stringify({
		type: "user",
		message: {
			content: [
				{
					type: "tool_result",
					tool_use_id: id,
					content: body,
					...(error ? { is_error: true } : {}),
				},
			],
		},
		...(toolUseResult ? { toolUseResult } : {}),
	});

const write = (...lines: string[]) =>
	fs.writeFileSync(file, `${lines.join("\n")}\n`);

describe("readPendingTasks", () => {
	it("reads a background Bash call that has not come back as pending", () => {
		write(bash("sleep 5", "t1", { run_in_background: true }));
		const seen = readPendingTasks(file);
		expect(seen.launches).toHaveLength(1);
		expect(seen.pending.map((l: { id: string }) => l.id)).toEqual(["t1"]);
		expect(seen.pending[0].kind).toBe("background command");
	});

	it("settles that call once its notification names the tool-use id", () => {
		write(bash("sleep 5", "t1", { run_in_background: true }), settlement("t1"));
		expect(readPendingTasks(file).pending).toEqual([]);
	});

	it("counts a subagent as a launch and settles it the same way", () => {
		write(toolUse("t1", "Agent", { description: "read the docs" }));
		expect(readPendingTasks(file).pending[0].kind).toBe("subagent");
		write(toolUse("t1", "Agent", {}), settlement("t1"));
		expect(readPendingTasks(file).pending).toEqual([]);
	});

	it("settles on a killed notification too — nothing will wake the session", () => {
		write(
			bash("sleep 5", "t1", { run_in_background: true }),
			settlement("t1", "killed"),
		);
		expect(readPendingTasks(file).pending).toEqual([]);
	});

	it("ignores a foreground Bash call, which no notification ever follows", () => {
		write(bash("ls", "t1"));
		expect(readPendingTasks(file).launches).toEqual([]);
	});

	it("ignores a subagent's own launches — they do not wake this session", () => {
		write(
			JSON.stringify(
				buildBashCall("sleep 5", "t1", {
					isSidechain: true,
					input: { run_in_background: true },
				}),
			),
		);
		expect(readPendingTasks(file).launches).toEqual([]);
	});

	it("never reads a launch record as its own settlement", () => {
		/* The id appears in the launch record's `id` field. Only the
		 * `<tool-use-id>` tag settles it, so one launch alone stays pending. */
		write(bash("x", "t1", { run_in_background: true }));
		expect(readPendingTasks(file).pending).toHaveLength(1);
	});

	it("keeps one launch pending while a sibling settles", () => {
		write(
			bash("a", "t1", { run_in_background: true }),
			bash("b", "t2", { run_in_background: true }),
			settlement("t1"),
		);
		expect(
			readPendingTasks(file).pending.map((l: { id: string }) => l.id),
		).toEqual(["t2"]);
	});

	it("skips an unparseable line without losing the records around it", () => {
		write("{not json", bash("a", "t1", { run_in_background: true }));
		const seen = readPendingTasks(file);
		expect(seen.records).toBe(1);
		expect(seen.pending).toHaveLength(1);
	});

	it("skips a line that parses to null rather than throwing (#1531)", () => {
		write("null");
		const seen = readPendingTasks(file);
		expect(seen.records).toBe(0);
		expect(seen.launches).toHaveLength(0);
	});

	it("skips a null line without losing the records around it (#1531)", () => {
		write(
			bash("a", "t1", { run_in_background: true }),
			"null",
			bash("b", "t2", { run_in_background: true }),
		);
		const seen = readPendingTasks(file);
		expect(seen.records).toBe(2);
		expect(seen.pending).toHaveLength(2);
	});

	it.each(["42", '"text"', "true", "[]"])(
		"skips a line that parses to the non-object %s, uncounted (#1531)",
		(line) => {
			write(line, bash("a", "t1", { run_in_background: true }));
			const seen = readPendingTasks(file);
			expect(seen.records).toBe(1);
			expect(seen.pending).toHaveLength(1);
		},
	);

	it("reports zero records for a transcript that says nothing", () => {
		write("");
		expect(readPendingTasks(file).records).toBe(0);
	});

	it("throws on an absent transcript, leaving the verdict to the caller", () => {
		expect(() => readPendingTasks(path.join(dir, "nope.jsonl"))).toThrow();
	});
});

describe("readPendingTasks settles a launch no notification follows (mantahostels#2487)", () => {
	const result = (id: string, body: string, error = false) =>
		toolResult(id, body, { error });

	const handle = "Command running in background with ID: b1. Output is being…";
	const asyncLaunched = "Async agent launched successfully. agentId: a1";

	it("settles a launch a PreToolUse hook refused", () => {
		write(
			bash("x", "t1", { run_in_background: true }),
			result("t1", "guard denied this command", true),
		);
		expect(readPendingTasks(file).pending).toEqual([]);
	});

	it("settles a foreground subagent, whose result is its own report", () => {
		write(toolUse("t1", "Agent", {}), result("t1", "Here is what I found."));
		expect(readPendingTasks(file).pending).toEqual([]);
	});

	it("keeps a subagent whose result announces a background handle", () => {
		write(toolUse("t1", "Agent", {}), result("t1", asyncLaunched));
		expect(readPendingTasks(file).pending).toHaveLength(1);
	});

	it("keeps a background command on the announcement alone", () => {
		/* The Bash limb never reads the announcement, so a harness rewording it
		 * cannot turn a Bash launch into a false refusal. */
		write(bash("x", "t1", { run_in_background: true }), result("t1", handle));
		expect(readPendingTasks(file).pending).toHaveLength(1);
		write(
			bash("x", "t2", { run_in_background: true }),
			result("t2", "some wording nobody has seen before"),
		);
		expect(readPendingTasks(file).pending).toHaveLength(1);
	});

	it("keeps a launch that has no result at all", () => {
		write(toolUse("t1", "Agent", {}));
		expect(readPendingTasks(file).pending).toHaveLength(1);
	});

	it("reads a structured result body, not only a string one", () => {
		write(
			toolUse("t1", "Agent", {}),
			JSON.stringify({
				type: "user",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "t1",
							content: [{ type: "text", text: asyncLaunched }],
						},
					],
				},
			}),
		);
		expect(readPendingTasks(file).pending).toHaveLength(1);
	});
});

describe("readPendingTasks counts a call moved to the background at its timeout (#1012)", () => {
	/* Copied from a real transcript, structured field included. */
	const moved =
		"Command did not complete within its 120s timeout and was moved to the background (ID: bfti0ymgk). Output is being written to: …";
	const overrun = (id: string, body = moved, withTaskId = true) =>
		toolResult(id, body, {
			toolUseResult: withTaskId
				? { backgroundTaskId: "bfti0ymgk", timedOutAfterMs: 120_000 }
				: undefined,
		});

	it("counts a foreground Bash call moved to the background at its timeout", () => {
		write(bash("npm run test", "t1"), overrun("t1"));
		const seen = readPendingTasks(file);
		expect(seen.pending.map((l: { id: string }) => l.id)).toEqual(["t1"]);
		expect(seen.pending[0].kind).toBe("background command");
	});

	it("settles that overrun once its notification names the tool-use id", () => {
		write(bash("npm run test", "t1"), overrun("t1"), settlement("t1"));
		const seen = readPendingTasks(file);
		expect(seen.launches).toHaveLength(1);
		expect(seen.pending).toEqual([]);
	});

	it("ignores output that only quotes the overrun announcement", () => {
		write(
			bash("grep moved transcript.jsonl", "t1"),
			overrun("t1", `L600: "${moved}"`, false),
		);
		expect(readPendingTasks(file).launches).toEqual([]);
	});

	it("ignores the announcement in a result that is not a Bash call's", () => {
		write(toolUse("t1", "Read", { file_path: "x" }), overrun("t1"));
		expect(readPendingTasks(file).launches).toEqual([]);
	});

	it("counts the overrun on its text alone", () => {
		write(bash("ls", "t1"), overrun("t1", moved, false));
		expect(readPendingTasks(file).pending).toHaveLength(1);
	});

	it("counts the overrun on its backgroundTaskId alone", () => {
		write(bash("ls", "t1"), overrun("t1", "reworded", true));
		expect(readPendingTasks(file).pending).toHaveLength(1);
	});

	it("still ignores a foreground Bash call that finished in time", () => {
		write(bash("ls", "t1"), overrun("t1", "a\nb", false));
		expect(readPendingTasks(file).launches).toEqual([]);
	});
});

/* #1166 */
describe("readPendingTasks counts a Skill call that forked into the background", () => {
	/* The result's text and structured field, as a real transcript wrote them. */
	const forked =
		'Skill "code-review" launched (forked execution, running in the background).';
	const forkedToolUseResult = {
		status: "forked",
		background: true,
		agentId: "abd4da2940db2a777",
	};
	const inlineResult = { success: true, commandName: "tdd" };
	const forkResult = (id: string, body = forked, error = false) =>
		toolResult(id, body, { error, toolUseResult: forkedToolUseResult });

	it("reads a forked Skill call that has not come back as pending", () => {
		write(toolUse("t1", "Skill", { skill: "code-review" }), forkResult("t1"));
		const seen = readPendingTasks(file);
		expect(seen.pending.map((l: { id: string }) => l.id)).toEqual(["t1"]);
		expect(seen.pending[0].kind).toBe("forked skill");
	});

	it("settles it once its notification names the Skill call's id", () => {
		write(
			toolUse("t1", "Skill", { skill: "code-review" }),
			forkResult("t1"),
			settlement("t1"),
		);
		const seen = readPendingTasks(file);
		expect(seen.launches).toHaveLength(1);
		expect(seen.pending).toEqual([]);
	});

	it("ignores a Skill call that ran inline", () => {
		write(
			toolUse("t1", "Skill", { skill: "tdd" }),
			toolResult("t1", "Launching skill: tdd", {
				toolUseResult: inlineResult,
			}),
		);
		expect(readPendingTasks(file).launches).toEqual([]);
	});

	it("settles a forked Skill call whose result is an error", () => {
		write(
			toolUse("t1", "Skill", { skill: "code-review" }),
			forkResult("t1", forked, true),
		);
		expect(readPendingTasks(file).pending).toEqual([]);
	});

	it("counts the fork on its text alone", () => {
		write(
			toolUse("t1", "Skill", { skill: "code-review" }),
			toolResult("t1", forked),
		);
		expect(readPendingTasks(file).pending).toHaveLength(1);
	});

	it("counts the fork on its structured field alone", () => {
		write(
			toolUse("t1", "Skill", { skill: "code-review" }),
			forkResult("t1", "reworded"),
		);
		expect(readPendingTasks(file).pending).toHaveLength(1);
	});

	it("ignores the announcement in a result that is not a Skill call's", () => {
		write(
			bash("grep forked transcript.jsonl", "t1"),
			forkResult("t1", `L2183: ${forked}`),
		);
		expect(readPendingTasks(file).launches).toEqual([]);
	});
});

describe("readPendingTasks settles a launch a TaskStop stopped (#2754)", () => {
	/* Copied from the #2754 transcript: the launch result names the handle in
	 * its text and in `backgroundTaskId`; the stop result names it in a JSON
	 * string body and in `task_id`. */
	const launched = (id: string, handle: string, structured = true) =>
		toolResult(
			id,
			`Command running in background with ID: ${handle}. Output is being written to: /tmp/tasks/${handle}.output.`,
			structured
				? { toolUseResult: { stdout: "", backgroundTaskId: handle } }
				: {},
		);
	const stopBody = (handle: string) =>
		JSON.stringify({
			message: `Successfully stopped task: ${handle} (node watch.js)`,
			task_id: handle,
			task_type: "local_bash",
		});
	const stopped = (id: string, handle: string, structured = true) =>
		toolResult(
			id,
			stopBody(handle),
			structured
				? { toolUseResult: { task_id: handle, task_type: "local_bash" } }
				: {},
		);

	it("settles a background command once TaskStop stops its handle", () => {
		write(
			bash("node watch.js", "t1", { run_in_background: true }),
			launched("t1", "bku29b47g"),
			toolUse("s1", "TaskStop", { task_id: "bku29b47g" }),
			stopped("s1", "bku29b47g"),
		);
		expect(readPendingTasks(file).pending).toEqual([]);
	});

	it("settles on the text of both results alone", () => {
		write(
			bash("node watch.js", "t1", { run_in_background: true }),
			launched("t1", "bku29b47g", false),
			toolUse("s1", "TaskStop", { task_id: "bku29b47g" }),
			stopped("s1", "bku29b47g", false),
		);
		expect(readPendingTasks(file).pending).toEqual([]);
	});

	it("settles a call moved to the background at its timeout, by its overrun handle", () => {
		write(
			bash("npm test", "t1"),
			toolResult(
				"t1",
				"Command did not complete within its 120s timeout and was moved to the background (ID: bfd7jihuf).",
			),
			toolUse("s1", "TaskStop", { task_id: "bfd7jihuf" }),
			stopped("s1", "bfd7jihuf", false),
		);
		expect(readPendingTasks(file).pending).toEqual([]);
	});

	it("settles an async subagent once TaskStop stops its agentId", () => {
		write(
			toolUse("t1", "Agent", { description: "Spec review" }),
			toolResult(
				"t1",
				"Async agent launched successfully.\nagentId: ad49ddab1fd8b8b5b (internal ID)",
				{
					toolUseResult: {
						status: "async_launched",
						agentId: "ad49ddab1fd8b8b5b",
					},
				},
			),
			toolUse("s1", "TaskStop", { task_id: "ad49ddab1fd8b8b5b" }),
			stopped("s1", "ad49ddab1fd8b8b5b"),
		);
		expect(readPendingTasks(file).pending).toEqual([]);
	});

	it("keeps a launch whose TaskStop found no such task", () => {
		write(
			bash("node watch.js", "t1", { run_in_background: true }),
			launched("t1", "bku29b47g"),
			toolUse("s1", "TaskStop", { task_id: "bku29b47g" }),
			toolResult(
				"s1",
				"<tool_use_error>No task found with ID: bku29b47g</tool_use_error>",
				{ error: true },
			),
		);
		expect(
			readPendingTasks(file).pending.map((l: { id: string }) => l.id),
		).toEqual(["t1"]);
	});

	it("keeps a sibling launch whose handle no TaskStop named", () => {
		write(
			bash("node a.js", "t1", { run_in_background: true }),
			launched("t1", "baaaaaaa1"),
			bash("node b.js", "t2", { run_in_background: true }),
			launched("t2", "bbbbbbbb2"),
			toolUse("s1", "TaskStop", { task_id: "baaaaaaa1" }),
			stopped("s1", "baaaaaaa1"),
		);
		expect(
			readPendingTasks(file).pending.map((l: { id: string }) => l.id),
		).toEqual(["t2"]);
	});

	it("ignores the stop announcement in a result that is not a TaskStop call's", () => {
		write(
			bash("node watch.js", "t1", { run_in_background: true }),
			launched("t1", "bku29b47g"),
			bash("grep stopped transcript.jsonl", "g1"),
			toolResult("g1", `L1968: ${stopBody("bku29b47g")}`),
		);
		expect(readPendingTasks(file).pending).toHaveLength(1);
	});
});

describe("readPendingTasks names each launch as the transcript does (#1201)", () => {
	const readPendingNames = () =>
		readPendingTasks(file).pending.map((l: { name: string }) => l.name);

	it("names a background command and a subagent by their description", () => {
		write(
			bash("sleep 5", "t1", {
				description: "Wait five seconds",
				run_in_background: true,
			}),
			toolUse("t2", "Agent", { description: "read the docs" }),
			toolResult("t2", "Async agent launched successfully"),
		);
		expect(readPendingNames()).toEqual(["Wait five seconds", "read the docs"]);
	});

	it("falls back to the command where a Bash call gives no description, on one line", () => {
		write(bash("sleep 5 &&\n  echo done", "t1", { run_in_background: true }));
		expect(readPendingNames()).toEqual(["sleep 5 && echo done"]);
	});

	it("names a call moved to the background at its timeout by the call's description", () => {
		write(
			bash("npm test", "t1", { description: "Run the suite" }),
			toolResult(
				"t1",
				"Command did not complete within its 120s timeout and was moved to the background (ID: b1).",
			),
		);
		expect(readPendingNames()).toEqual(["Run the suite"]);
	});

	it("names a forked Skill call by the skill", () => {
		write(
			toolUse("t1", "Skill", { skill: "research" }),
			toolResult(
				"t1",
				'Skill "research" launched (forked execution, running in the background)',
			),
		);
		expect(readPendingNames()).toEqual(["research"]);
	});
});
