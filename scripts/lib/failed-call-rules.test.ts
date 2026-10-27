// @vitest-environment node
/*
 * lib/failed-call-rules.js, guard-failed-call-rules.js's core (#2026, ported
 * at #2799), in process: a Bash call killed by a signal is handed
 * `rule:silent-kill`, a batch holding a Skill refused as slash-only
 * `rule:skill-refused`.
 *
 * Loosen the silent cases and every failed call or batch carries a rule the
 * session did not need; loosen the firing ones and the rule, gone from the
 * pool, reaches nobody. The rule store is the real one, so a case compares
 * against the fragment a session would be handed.
 */

import { describe, expect, it } from "vitest";
import { kitContextFake } from "./kit-context-fake";
import { readRuleText } from "./rule-text";

const { decide } = require("./failed-call-rules.js") as {
	decide: (event: string, ctx: object) => { context: string } | null;
};

const SILENT_KILL = readRuleText("silent-kill");
const SKILL_REFUSED = readRuleText("skill-refused");

const run = (
	payload: Record<string, unknown>,
	ruleText: (id: string) => string = readRuleText,
) => {
	const logged: string[] = [];
	const out = decide(
		String(payload.hook_event_name),
		kitContextFake({
			payload,
			ruleText,
			log: (what: string) => logged.push(what),
		}),
	);
	return { said: out?.context ?? "", logged };
};

const failure = (error: unknown, extra: Record<string, unknown> = {}) =>
	run({
		hook_event_name: "PostToolUseFailure",
		tool_name: "Bash",
		tool_input: { command: "npm run build" },
		error,
		is_interrupt: false,
		...extra,
	});

const batch = (calls: unknown) =>
	run({ hook_event_name: "PostToolBatch", tool_calls: calls });

const REFUSAL =
	"<tool_use_error>Skill implement cannot be used with Skill tool due to disable-model-invocation. Ask the user to run /implement themselves — it cannot be invoked via the Skill tool.</tool_use_error>";
const skill = (response: unknown, tool = "Skill") => ({
	tool_name: tool,
	tool_input: { skill: "implement" },
	tool_use_id: "b",
	tool_response: response,
});

describe("a Bash call killed by a signal", () => {
	it.each([
		"Exit code 137\nKilled",
		"Exit code 143\nTerminated",
		"Exit code 137",
		"npm ERR!\nExit code 143",
	])("hands over the silent-kill rule on %j", (error) => {
		expect(failure(error).said).toBe(SILENT_KILL);
	});

	it.each([
		["an ordinary non-zero exit", "Exit code 1\nnpm ERR!"],
		["a longer number", "Exit code 1370"],
		["a code mid-line", "the Exit code 137 was"],
		["no error at all", undefined],
		["an error that is no string", 137],
	])("stays silent on %s", (_, error) => {
		expect(failure(error).said).toBe("");
	});

	it("stays silent on a call the user interrupted, or a tool other than Bash", () => {
		expect(failure("Exit code 143", { is_interrupt: true }).said).toBe("");
		expect(failure("Exit code 137", { tool_name: "Read" }).said).toBe("");
	});
});

describe("a Skill call refused as slash-only", () => {
	it("hands over the skill-refused rule from the batch's results", () => {
		expect(
			batch([
				{
					tool_name: "Read",
					tool_input: {},
					tool_use_id: "a",
					tool_response: "ok",
				},
				skill(REFUSAL),
			]).said,
		).toBe(SKILL_REFUSED);
	});

	it("reads a result carried as content blocks, not only as a string", () => {
		expect(batch([skill([{ type: "text", text: REFUSAL }])]).said).toBe(
			SKILL_REFUSED,
		);
	});

	it.each([
		["a Skill call that loaded", [skill("Launching skill: tdd")]],
		["another tool quoting the refusal", [skill(REFUSAL, "Bash")]],
		["a batch with no calls", []],
		["a batch whose calls are not a list", "nope"],
		["a call with no result", [skill(undefined)]],
	])("stays silent on %s", (_, calls) => {
		expect(batch(calls).said).toBe("");
	});
});

describe("the events it answers", () => {
	it("stays silent on any other event, even one carrying a killed call", () => {
		expect(
			run({
				hook_event_name: "PostToolUse",
				tool_name: "Bash",
				error: "Exit code 137",
			}).said,
		).toBe("");
	});

	it("stays silent, and logs why, where the rule store cannot give the fragment", () => {
		const r = run(
			{
				hook_event_name: "PostToolUseFailure",
				tool_name: "Bash",
				error: "Exit code 137",
			},
			() => {
				throw new Error("no fragment");
			},
		);
		expect(r.said).toBe("");
		expect(r.logged).toEqual([
			"rule fragment unreadable — a PostToolUseFailure rule went unsaid",
		]);
	});

	it("stays silent, and logs why, where the fragment is empty", () => {
		const r = run(
			{ hook_event_name: "PostToolBatch", tool_calls: [skill(REFUSAL)] },
			() => "",
		);
		expect(r.said).toBe("");
		expect(r.logged).toEqual([
			"rule fragment unreadable — a PostToolBatch rule went unsaid",
		]);
	});
});
