// @vitest-environment node
/*
 * guard-anthropic-report.js refuses every `gh issue`, `gh pr` and writing
 * `gh api` call it can tie to an `anthropics/*` repo (#1987; the ruling,
 * #1967). These are its boundary cases: the line hooks/hooks.json registers,
 * run by bash as the harness runs it, on a harness-shaped payload — the
 * wiring, each exit and its stream, each input channel, the fail-open record
 * on disk, and the rule store and git crossed for real. Which command is
 * refused, and why, is lib/anthropic-report.test.ts's (#2798).
 *
 * CLAUDE_PLUGIN_ROOT is this checkout, so the line finds the real entry;
 * CLAUDE_PROJECT_DIR is a temp project, so the fail-open log lands in the
 * temp CLAUDE_CONFIG_DIR and never the founder's.
 *
 * Break the line and an upstream report goes out unrefused; make it deny on
 * a fault and every `gh` call is wedged.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	failOpenLogPath,
	readFailOpenLog,
	readFailOpenRecords,
} from "./guard-log-fixture";
import {
	buildBashPayload,
	entryBesideThrowingCore,
	expectShellHooks,
	guardDirs,
	guardOutput,
	hookLineOutput,
	readHookLines,
} from "./lib/pretool-guard-testkit";

const SCRIPT = "scripts/guard-anthropic-report.js";
const LINES = readHookLines("hooks/hooks.json", SCRIPT);
const { readRuleText } = require("./lib/rule-text") as {
	readRuleText: (id: string) => string;
};

let dir: string;
let config: string;

beforeEach(() => {
	({ dir, config } = guardDirs("anthropic-report-entry-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

// A GH_REPO the runner happens to carry would decide every unnamed case.
const NO_GH_REPO = { GH_REPO: undefined };

/** The hook's hookSpecificOutput for `command`, run in `cwd`. */
const emission = (
	command: string,
	{
		cwd = dir,
		stdin,
		env = {},
	}: { cwd?: string; stdin?: string; env?: NodeJS.ProcessEnv } = {},
) =>
	hookLineOutput(LINES[0] ?? "", command, {
		project: dir,
		config,
		cwd: dir,
		payload: { cwd },
		stdin,
		env: { ...NO_GH_REPO, ...env },
	});

/** A real clone with one remote. */
const clone = (url: string) => {
	const at = path.join(dir, "clone");
	fs.mkdirSync(at);
	spawnSync("git", ["init", "-q", at]);
	spawnSync("git", ["-C", at, "remote", "add", "upstream", url]);
	return at;
};

describe("the registered hook line", () => {
	it("is one line, narrowed by the wrapper-tolerant `if: Bash(*gh *)`, in the plugin and the self-plugin alike", () => {
		expectShellHooks(SCRIPT, () => ({
			if: "Bash(*gh *)",
			onFailure: "block",
		}));
	});
});

describe("each exit", () => {
	it("refuses as permissionDecision JSON on exit 0, splicing the stored rule", () => {
		const out = emission(
			'gh pr create -R anthropics/claude-code --title "x" --body "y"',
		);
		expect(out.hookEventName).toBe("PreToolUse");
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toBe(
			`This writes to an Anthropic repo (anthropics/claude-code): gh pr create -R anthropics/claude-code --title "…" --body "…"\n\n${readRuleText("anthropic-report")}`,
		);
		expect(readFailOpenRecords(config, dir)).toEqual([]);
	});

	it("still refuses, naming the fragment, where the rule store cannot give it", () => {
		const out = emission("gh issue comment 5 --repo anthropics/claude-code", {
			env: { WFC_RULES_DIR: fs.mkdtempSync(path.join(dir, "store-")) },
		});
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(
			"docs/agents/rules/anthropic-report.txt",
		);
	});

	it("says nothing, and records nothing, about a command it judged and passed", () => {
		expect(emission("git status")).toBeNull();
		expect(
			emission("gh issue view 5 --repo anthropics/claude-code"),
		).toBeNull();
		expect(fs.existsSync(failOpenLogPath(config, dir))).toBe(false);
	});

	it("fails open on a repo it cannot read, one record naming itself in three tab-separated fields", () => {
		expect(
			emission('gh issue create --repo "$R" --title "x" --body "y"'),
		).toBeNull();
		expect(readFailOpenRecords(config, dir)).toEqual([
			[
				expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
				"guard-anthropic-report.js",
				"could not read the --repo of a gh issue create — allowed unchecked for an Anthropic repo",
			],
		]);
	});

	it("refuses, logged, where its core throws", () => {
		const out = guardOutput(
			entryBesideThrowingCore(dir, SCRIPT, "anthropic-report.js"),
			buildBashPayload("gh issue list", "s1"),
			{ project: dir, config, cwd: dir },
		);
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toBe(
			"guard-anthropic-report.js could not judge this command, so it refuses it: broke",
		);
		expect(readFailOpenLog(config, dir)).toMatch(
			/core threw — the command was refused\tbroke/,
		);
	});

	it("fails open, exit 0 and silent, where node is not on PATH", () => {
		expect(
			emission("gh issue comment 5 --repo anthropics/claude-code", {
				env: { PATH: "/nonexistent" },
			}),
		).toBeNull();
	});
});

describe("each input channel", () => {
	it("treats an empty payload as nothing to check, not a fault", () => {
		expect(emission("", { stdin: "" })).toBeNull();
		expect(fs.existsSync(failOpenLogPath(config, dir))).toBe(false);
	});

	it("allows a payload that is not JSON, and records that it did", () => {
		expect(emission("", { stdin: "not json" })).toBeNull();
		expect(readFailOpenRecords(config, dir).map((f) => f[2])).toEqual([
			expect.stringContaining("payload did not parse as JSON"),
		]);
	});

	it("allows a payload carrying no command, and records that it did", () => {
		expect(
			emission("", {
				stdin: JSON.stringify({
					session_id: "s1",
					tool_name: "Bash",
					tool_input: {},
				}),
			}),
		).toBeNull();
		expect(readFailOpenRecords(config, dir).map((f) => f[2])).toEqual([
			expect.stringContaining("no command in payload"),
		]);
	});

	it("reads GH_REPO from the hook's environment", () => {
		expect(
			emission('gh issue create --title "x" --body "y"', {
				env: { GH_REPO: "anthropics/claude-code" },
			}).permissionDecision,
		).toBe("deny");
	});
});

describe("the clone's remotes, read by real git in the payload's cwd", () => {
	it("refuses an unnamed write where a remote is an Anthropic repo", () => {
		const at = clone("https://github.com/anthropics/claude-code.git");
		expect(
			emission('gh issue create --title "x" --body "y"', { cwd: at })
				.permissionDecisionReason,
		).toContain("(anthropics/claude-code)");
	});

	it("allows it in a clone of any other repo, and outside any clone", () => {
		const at = clone("https://github.com/someone/tool.git");
		expect(
			emission('gh issue create --title "x" --body "y"', { cwd: at }),
		).toBeNull();
		expect(emission('gh issue create --title "x" --body "y"')).toBeNull();
		expect(fs.existsSync(failOpenLogPath(config, dir))).toBe(false);
	});
});
