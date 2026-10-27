// @vitest-environment node
/*
 * The guard-anthropic-report core of guard-dispatch.js refuses every
 * `gh issue`, `gh pr` and writing `gh api` call it can tie to an
 * `anthropics/*` repo (#1987; the ruling, #1967). These are its boundary
 * cases, the dispatcher entry run on it alone on a harness-shaped payload:
 * each exit, each input channel, the fail-open record on disk, and the rule
 * store and git crossed for real. Which command is refused, and why, is
 * lib/anthropic-report.test.ts's; the entry's payload faults and the throw
 * policy are guard-dispatch's own tests' (#2798, #3224).
 *
 * CLAUDE_PROJECT_DIR is a temp project, so the fail-open log lands in the
 * temp CLAUDE_CONFIG_DIR and never the founder's.
 *
 * Make it allow an upstream report and one goes out unrefused; make it deny
 * on a fault and every `gh` call is wedged.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOpenLogPath, readFailOpenRecords } from "./guard-log-fixture";
import {
	buildBashPayload,
	dispatchCoreOutput,
	guardDirs,
} from "./lib/pretool-guard-testkit";

const CORE = "guard-anthropic-report";
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

/** The core's hookSpecificOutput for `command`, run in `cwd`. */
const emission = (
	command: string,
	{ cwd = dir, env = {} }: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) =>
	dispatchCoreOutput(
		CORE,
		{ ...buildBashPayload(command, "s1"), cwd },
		{ project: dir, config, cwd: dir, env: { ...NO_GH_REPO, ...env } },
	);

/** A real clone with one remote. */
const clone = (url: string) => {
	const at = path.join(dir, "clone");
	fs.mkdirSync(at);
	spawnSync("git", ["init", "-q", at]);
	spawnSync("git", ["-C", at, "remote", "add", "upstream", url]);
	return at;
};

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
				CORE,
				"could not read the --repo of a gh issue create — allowed unchecked for an Anthropic repo",
			],
		]);
	});
});

describe("each input channel", () => {
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
