// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineTemplate, mkScratchDir } from "./git-fixture";
import { runCore } from "./guard-core-testkit";

const PACKAGE = {
	scripts: {
		test: "node scripts/run-vitest.js",
		"test:changed": "node scripts/run-vitest.js --changed",
		"test:py": "node scripts/run-pytest.js",
		lint: "biome check .",
	},
};

const repo = defineTemplate((root) => {
	execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: root });
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(PACKAGE));
});

let dir: string;

const run = (
	toolInput: Record<string, unknown>,
	{ env = {}, agent }: { env?: Record<string, string>; agent?: string } = {},
) =>
	runCore(
		"guard-test-timeout",
		{
			session_id: "test",
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input: toolInput,
			...(agent ? { agent_id: agent } : {}),
		},
		{ root: dir, env },
	).output;

const refusal = (command: string, timeout: unknown = 600_000) => {
	const out = run({ command, timeout });
	return out?.permissionDecision === "deny"
		? (out.permissionDecisionReason ?? "")
		: null;
};

beforeEach(() => {
	dir = repo.instantiate(mkScratchDir("test-timeout-"));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("a session's own snapshot test run over 30 s", () => {
	it.each([
		["a touched run", "npm run test"],
		["a named run", "npm run test -- scripts/a.test.ts scripts/b.test.ts"],
		["a changed run", "npm run test:changed"],
		["the wrapper itself", "node scripts/run-vitest.js scripts/a.test.ts"],
		["a run inside bg-run.sh", "scripts/bg-run.sh run t npm run test"],
		["a run piped to tail", "npm run test 2>&1 | tail -40"],
		[
			"a run under a heap cap",
			"NODE_OPTIONS=--max-old-space-size=2048 npm run test",
		],
		["a run followed by a second command", "npm run test; echo done"],
		["a run after a cd", "cd sub && npm run test -- a.test.ts"],
		["a run in a shell timeout", "timeout 580 npm run test -- a.test.ts"],
	])("is refused, naming the 30 s timeout: %s", (_, command) => {
		const reason = refusal(command);
		expect(reason).toContain("Re-send the same command with `timeout: 30000`.");
		expect(reason).toContain("not `timeout: 600000`");
	});

	it("is refused where it set no timeout, the harness's default being longer", () => {
		expect(
			run({ command: "npm run test" })?.permissionDecisionReason,
		).toContain("not no `timeout`");
	});

	it.each([
		["already at 30 s", 30_000],
		["shorter than 30 s", 10_000],
	])("is let through %s", (_, timeout) => {
		expect(refusal("npm run test", timeout)).toBeNull();
	});

	it("is let through when run in the background", () => {
		expect(
			run({
				command: "npm run test",
				timeout: 600_000,
				run_in_background: true,
			}),
		).toBeNull();
	});

	it("is let through under the escape", () => {
		expect(refusal("WFC_TEST_TIMEOUT=1 npm run test")).toBeNull();
	});
});

describe("a command launching no snapshot run, or another suite beside one, keeps its timeout", () => {
	it.each([
		["a --full run", "npm run test -- --full=release"],
		["a bare --full run", "npm run test -- --full"],
		[
			"a --full run inside bg-run.sh",
			"scripts/bg-run.sh run full npm run test -- --full=release",
		],
		["a --queue run", "npm run test -- --queue"],
		[
			"a --queue run inside bg-run.sh",
			"scripts/bg-run.sh run q npm run test -- --queue scripts/a.test.ts",
		],
		["a --shared run", "npm run test -- --shared"],
		["an --isolated run", "npm run test -- --isolated"],
		["a pytest run", "npm run test:py"],
		["another npm script", "npm run lint"],
		[
			"a command holding a --full run beside a touched one",
			"npm run test; npm run test -- --full=release",
		],
	])("is let through: %s", (_, command) => {
		expect(refusal(command)).toBeNull();
	});

	it("is let through where the repo has no test script", () => {
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ scripts: { lint: "biome check ." } }),
		);
		expect(refusal("npm run test")).toBeNull();
	});

	it("is let through where package.json is absent", () => {
		fs.rmSync(path.join(dir, "package.json"));
		expect(refusal("npm run test")).toBeNull();
	});

	it("is let through where the test script is not the wrapper", () => {
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ scripts: { test: "vitest run" } }),
		);
		expect(refusal("npm run test")).toBeNull();
	});
});

describe("what the refusal says to do once the run moves", () => {
	const reason = (opts: { env?: Record<string, string>; agent?: string }) =>
		run({ command: "npm run test", timeout: 600_000 }, opts)
			?.permissionDecisionReason ?? "";

	it("tells an interactive session to keep working, then end the turn", () => {
		expect(reason({})).toContain("end the turn with NO tool call");
	});

	it("tells a background job to hold the turn on the in-flight wait", () => {
		expect(reason({ env: { CLAUDE_JOB_DIR: dir } })).toContain(
			"hold the turn on `node scripts/in-flight-runs.js wait`",
		);
	});

	it("tells a subagent to wait inside its turn", () => {
		expect(reason({ agent: "a1" })).toContain("You are a subagent");
	});
});
