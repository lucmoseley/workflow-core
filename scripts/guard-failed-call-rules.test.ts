// @vitest-environment node
/*
 * guard-failed-call-rules.test.ts — the PostToolUseFailure and PostToolBatch
 * hook that hands back the out-of-memory and refused-Skill rules (#2026).
 *
 * Loosen the silent cases and every failed call or batch carries a rule the
 * session did not need; loosen the firing ones and the rule, gone from the
 * pool, reaches nobody.
 *
 * It spawns the real guard on payloads shaped as the harness sends them and
 * compares against the real fragments, since what reaches a session is the
 * script's stdout and nothing short of it.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const GUARD = path.resolve(__dirname, "guard-failed-call-rules.sh");
const fragment = (file: string) =>
	fs.readFileSync(path.resolve(__dirname, "..", file), "utf8").trimEnd();
const SILENT_KILL = fragment("docs/agents/rules/silent-kill.txt");
const SKILL_REFUSED = fragment("docs/agents/rules/skill-refused.txt");

/* The guard's fail-open log goes here, never the live config dir (mantahostels#1452). */
const CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "failed-call-rules-"));

const run = (payload: Record<string, unknown>) =>
	spawnSync(GUARD, [], {
		encoding: "utf8",
		env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG },
		input: JSON.stringify({ session_id: "sess-2026", ...payload }),
	});

/** The additionalContext the hook printed for `event`, or "" where silent. */
function said(r: ReturnType<typeof run>, event: string): string {
	expect(r.status).toBe(0);
	if (r.stdout.trim() === "") return "";
	const out = JSON.parse(r.stdout).hookSpecificOutput;
	expect(out.hookEventName).toBe(event);
	return out.additionalContext;
}

const failure = (error: string, extra: Record<string, unknown> = {}) =>
	run({
		hook_event_name: "PostToolUseFailure",
		tool_name: "Bash",
		tool_input: { command: "npm run build" },
		tool_use_id: "t1",
		error,
		is_interrupt: false,
		...extra,
	});

const batch = (calls: Record<string, unknown>[]) =>
	run({ hook_event_name: "PostToolBatch", tool_calls: calls });

const REFUSAL =
	"<tool_use_error>Skill implement cannot be used with Skill tool due to disable-model-invocation. Ask the user to run /implement themselves — it cannot be invoked via the Skill tool.</tool_use_error>";

describe("a Bash call killed by a signal", () => {
	it.each(["Exit code 137\nKilled", "Exit code 143\nTerminated"])(
		"hands over the silent-kill rule on %j",
		(error) => {
			expect(said(failure(error), "PostToolUseFailure")).toBe(SILENT_KILL);
		},
	);

	it("stays silent on an ordinary non-zero exit", () => {
		expect(said(failure("Exit code 1\nnpm ERR!"), "PostToolUseFailure")).toBe(
			"",
		);
	});

	it("stays silent where the code is only part of a longer number", () => {
		expect(said(failure("Exit code 1370"), "PostToolUseFailure")).toBe("");
	});

	it("stays silent on a call the user interrupted", () => {
		expect(
			said(
				failure("Exit code 143", { is_interrupt: true }),
				"PostToolUseFailure",
			),
		).toBe("");
	});

	it("stays silent on a tool other than Bash", () => {
		expect(
			said(
				failure("Exit code 137", { tool_name: "Read" }),
				"PostToolUseFailure",
			),
		).toBe("");
	});
});

describe("a Skill call refused as slash-only", () => {
	it("hands over the skill-refused rule from the batch's results", () => {
		const text = said(
			batch([
				{
					tool_name: "Read",
					tool_input: {},
					tool_use_id: "a",
					tool_response: "ok",
				},
				{
					tool_name: "Skill",
					tool_input: { skill: "implement" },
					tool_use_id: "b",
					tool_response: REFUSAL,
				},
			]),
			"PostToolBatch",
		);
		expect(text).toBe(SKILL_REFUSED);
	});

	it("reads a result carried as content blocks, not only as a string", () => {
		const text = said(
			batch([
				{
					tool_name: "Skill",
					tool_input: { skill: "triage" },
					tool_use_id: "b",
					tool_response: [{ type: "text", text: REFUSAL }],
				},
			]),
			"PostToolBatch",
		);
		expect(text).toBe(SKILL_REFUSED);
	});

	it("stays silent on a Skill call that loaded", () => {
		expect(
			said(
				batch([
					{
						tool_name: "Skill",
						tool_input: { skill: "tdd" },
						tool_use_id: "b",
						tool_response: "Launching skill: tdd",
					},
				]),
				"PostToolBatch",
			),
		).toBe("");
	});

	it("stays silent where another tool's output merely quotes the refusal", () => {
		expect(
			said(
				batch([
					{
						tool_name: "Bash",
						tool_input: { command: "grep -r disable-model-invocation" },
						tool_use_id: "b",
						tool_response: REFUSAL,
					},
				]),
				"PostToolBatch",
			),
		).toBe("");
	});
});
