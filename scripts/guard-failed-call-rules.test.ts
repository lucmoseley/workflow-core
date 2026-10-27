// @vitest-environment node
/*
 * guard-failed-call-rules.js hands back the silent-kill rule on a Bash call
 * killed by a signal, and the skill-refused rule on a batch holding a Skill
 * refused as slash-only (#2026). These are its boundary cases: the lines
 * hooks/hooks.json registers on PostToolUseFailure and PostToolBatch, run by
 * bash as the harness runs them, on a harness-shaped payload — the wiring,
 * each exit, the fail-open record, and the rule store crossed for real.
 * Which failure or batch draws a rule is lib/failed-call-rules.test.ts's
 * (#2799).
 *
 * Break a line and the rule, gone from the pool, reaches nobody.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFailOpenLog } from "./guard-log-fixture";
import {
	guardDirs,
	guardOutput,
	readHookLines,
} from "./lib/pretool-guard-testkit";
import { readRuleText } from "./lib/rule-text";

const SCRIPT = "scripts/guard-failed-call-rules.js";
const LINES = readHookLines("hooks/hooks.json", SCRIPT);
const CHECKOUT = path.resolve(__dirname, "..");
const REFUSAL =
	"<tool_use_error>Skill implement cannot be used with Skill tool due to disable-model-invocation.</tool_use_error>";

let dir: string;
let config: string;

beforeEach(() => {
	({ dir, config } = guardDirs("failed-call-rules-entry-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const fire = (
	line: string,
	payload: Record<string, unknown>,
	{ stdin, env = {} }: { stdin?: string; env?: NodeJS.ProcessEnv } = {},
) =>
	guardOutput(
		"/bin/bash",
		{ session_id: "sess-2026", ...payload },
		{
			project: dir,
			config,
			cwd: dir,
			args: ["-c", line],
			stdin,
			env: { CLAUDE_PLUGIN_ROOT: CHECKOUT, ...env },
		},
	);

const killed = (run = {}) =>
	fire(
		LINES[0] ?? "",
		{
			hook_event_name: "PostToolUseFailure",
			tool_name: "Bash",
			tool_input: { command: "npm run build" },
			error: "Exit code 137\nKilled",
			is_interrupt: false,
		},
		run,
	);

const readFaults = () => readFailOpenLog(config, dir);

describe("the registered hook lines", () => {
	it("are one on PostToolUseFailure and one on PostToolBatch, unnarrowed, in the plugin and the self-plugin alike", () => {
		for (const file of ["hooks/hooks.json", "self-plugin/hooks/hooks.json"]) {
			const hooks = JSON.parse(
				fs.readFileSync(path.join(CHECKOUT, file), "utf8"),
			).hooks as Record<string, { hooks: Record<string, unknown>[] }[]>;
			for (const event of ["PostToolUseFailure", "PostToolBatch"]) {
				const entries = (hooks[event] ?? [])
					.flatMap((group) => group.hooks)
					.filter((hook) => String(hook.command).includes(SCRIPT));
				expect(entries).toHaveLength(1);
				expect(entries[0]).not.toHaveProperty("if");
				expect(entries[0]).not.toHaveProperty("args");
			}
		}
		expect(LINES).toHaveLength(2);
	});
});

describe("each exit", () => {
	it("hands a killed call the stored silent-kill rule as PostToolUseFailure additionalContext on exit 0", () => {
		const out = killed();
		expect(out.hookEventName).toBe("PostToolUseFailure");
		expect(out.additionalContext).toBe(readRuleText("silent-kill"));
		expect(readFaults()).toBe("");
	});

	it("hands a refused Skill's batch the stored skill-refused rule as PostToolBatch additionalContext", () => {
		const out = fire(LINES[1] ?? "", {
			hook_event_name: "PostToolBatch",
			tool_calls: [
				{
					tool_name: "Skill",
					tool_input: { skill: "implement" },
					tool_use_id: "b",
					tool_response: REFUSAL,
				},
			],
		});
		expect(out.hookEventName).toBe("PostToolBatch");
		expect(out.additionalContext).toBe(readRuleText("skill-refused"));
	});

	it("is silent on an ordinary failure", () => {
		expect(
			fire(LINES[0] ?? "", {
				hook_event_name: "PostToolUseFailure",
				tool_name: "Bash",
				error: "Exit code 1",
			}),
		).toBeNull();
	});
});

describe("what it fails open on", () => {
	it("is silent where the rule store holds no fragment, and records why", () => {
		const store = fs.mkdtempSync(path.join(dir, "store-"));
		expect(killed({ env: { WFC_RULES_DIR: store } })).toBeNull();
		expect(readFaults()).toMatch(
			/guard-failed-call-rules\.js\trule fragment unreadable — a PostToolUseFailure rule went unsaid/,
		);
	});

	it("is silent on a payload that is not JSON, and records that it did", () => {
		expect(killed({ stdin: "not json" })).toBeNull();
		expect(readFaults()).toMatch(
			/guard-failed-call-rules\.js\t.*payload did not parse as JSON/,
		);
	});

	it("is silent, exit 0, where node is not on PATH", () => {
		expect(killed({ env: { PATH: "/nonexistent" } })).toBeNull();
	});
});
