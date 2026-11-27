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

const SHIPPED_BG_RUN = path.resolve(__dirname, "..", "bg-run.sh");

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

const rewritten = (command: string, timeout: unknown = 600_000) =>
	run({ command, timeout, description: "d" })?.updatedInput;

beforeEach(() => {
	dir = repo.instantiate(mkScratchDir("test-timeout-"));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("a session's own snapshot test run", () => {
	it.each([
		["a touched run", "npm run test"],
		["a named run", "npm run test -- scripts/a.test.ts scripts/b.test.ts"],
		["a changed run", "npm run test:changed"],
		["the wrapper itself", "node scripts/run-vitest.js scripts/a.test.ts"],
		["a run inside bg-run.sh", "scripts/bg-run.sh run t npm run test"],
		[
			"a run inside the shipped bg-run.sh",
			`${SHIPPED_BG_RUN} run t npm run test -- scripts/a.test.ts`,
		],
		["a run piped to tail", "npm run test 2>&1 | tail -40"],
		[
			"a run filtered by a quoted pattern",
			"npm run test -- scripts/a.test.ts 2>&1 | grep -E 'FAIL|✓' | head -n 20",
		],
		["a name filter", 'npm run test -- scripts/a.test.ts -t "keeps it"'],
	])("is moved to the 30 s timeout: %s", (_, command) => {
		expect(rewritten(command)).toEqual({
			command,
			timeout: 30_000,
			description: "d",
		});
	});

	it("gets the 30 s timeout where it set none", () => {
		expect(run({ command: "npm run test" })?.updatedInput).toEqual({
			command: "npm run test",
			timeout: 30_000,
		});
	});

	it("is allowed, since the harness applies a rewrite only with allow", () => {
		expect(run({ command: "npm run test", timeout: 600_000 })).toMatchObject({
			permissionDecision: "allow",
		});
	});

	it.each([
		["already at 30 s", 30_000],
		["shorter than 30 s", 10_000],
	])("is left alone %s", (_, timeout) => {
		expect(rewritten("npm run test", timeout)).toBeUndefined();
	});

	it("is left alone when run in the background", () => {
		expect(
			run({
				command: "npm run test",
				timeout: 600_000,
				run_in_background: true,
			}),
		).toBeNull();
	});
});

describe("a run the snapshot does not cover keeps its timeout", () => {
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
	])("%s", (_, command) => {
		expect(run({ command, timeout: 600_000 })).toBeNull();
	});

	it("leaves a test script that is not the wrapper alone", () => {
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ scripts: { test: "vitest run" } }),
		);
		expect(run({ command: "npm run test", timeout: 600_000 })).toBeNull();
	});
});

describe("a command the rewrite would auto-approve beyond the run", () => {
	it.each([
		["a second command", "npm run test; rm -rf x"],
		["an and-list", "npm run test && git push"],
		["a command substitution", "npm run test -- $(cat list)"],
		["a backtick", "npm run test -- `cat list`"],
		["a variable in double quotes", 'npm run test -- "$X"'],
		["a write redirect", "npm run test > out.txt"],
		["a pipe into another program", "npm run test | sh"],
		["a leading assignment", "NODE_OPTIONS=--require=x npm run test"],
		["an npm config flag", "npm run test --prefix=/tmp/x"],
		["an npm flag before run", "npm --prefix /tmp/x run test"],
		["a foreign npm", "/tmp/x/npm run test"],
		["a foreign run-vitest.js", "node /tmp/x/run-vitest.js"],
		["a foreign bg-run.sh", "/tmp/x/bg-run.sh run t npm run test"],
		["a second line", "npm run test\nrm -rf x"],
		["an unclosed quote", "npm run test -- 'a"],
		["a cd first", "cd sub && npm run test"],
	])("is left alone: %s", (_, command) => {
		expect(run({ command, timeout: 600_000 })).toBeNull();
	});
});

describe("the note on a rewrite", () => {
	const note = (opts: { env?: Record<string, string>; agent?: string }) =>
		run({ command: "npm run test", timeout: 600_000 }, opts)
			?.additionalContext ?? "";

	it("tells an interactive session to keep working, then end the turn", () => {
		const text = note({});
		expect(text).toContain("set to 30000 (#5800)");
		expect(text).toContain("end the turn with NO tool call");
	});

	it("tells a background job to hold the turn on the in-flight wait", () => {
		expect(note({ env: { CLAUDE_JOB_DIR: dir } })).toContain(
			"hold the turn on `node scripts/in-flight-runs.js wait`",
		);
	});

	it("tells a subagent to wait inside its turn", () => {
		expect(note({ agent: "a1" })).toContain("You are a subagent");
	});
});
