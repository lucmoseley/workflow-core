// @vitest-environment node
/*
 * guard-issue-body.js refuses a raw issue-body write (mantahostels#132).
 * These are its boundary cases: the line hooks/hooks.json registers, run by
 * bash as the harness runs it, on a harness-shaped payload — the wiring, each
 * exit and its stream, the fail-open record on disk, and the rule store and
 * the script-path resolver crossed for real. Which command is refused, and
 * why, is lib/issue-body-write.test.ts's (#2798). The guard calls no gh and
 * reads no file of its own, so there is no other adapter to cross.
 *
 * CLAUDE_PLUGIN_ROOT is this checkout, so the line finds the real entry;
 * CLAUDE_PROJECT_DIR is a temp project, so the fail-open log lands in the
 * temp CLAUDE_CONFIG_DIR and never the founder's.
 *
 * Break the line and a whole-body `gh issue edit` silently erases a parallel
 * session's edit; make it deny on a fault and every `gh` call is wedged.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFailOpenLog, readFailOpenRecords } from "./guard-log-fixture";
import {
	buildBashPayload,
	entryBesideThrowingCore,
	expectShellHooks,
	guardDirs,
	guardOutput,
	hookLineOutput,
	readHookLines,
} from "./lib/pretool-guard-testkit";

const SCRIPT = "scripts/guard-issue-body.js";
const LINES = readHookLines("hooks/hooks.json", SCRIPT);
const { readRuleText } = require("./lib/rule-text") as {
	readRuleText: (id: string) => string;
};

let dir: string;
let config: string;

beforeEach(() => {
	({ dir, config } = guardDirs("issue-body-entry-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The hook's hookSpecificOutput for `command`, run in `cwd`. */
const emission = (
	command: string,
	run: { stdin?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {},
) =>
	hookLineOutput(LINES[0] ?? "", command, {
		project: dir,
		config,
		cwd: dir,
		...run,
	});

describe("the registered hook line", () => {
	it("is one line, narrowed by `if: Bash(gh *)`, in the plugin and the self-plugin alike (mantahostels#2127)", () => {
		expectShellHooks(SCRIPT, () => ({
			if: "Bash(gh *)",
			onFailure: "block",
		}));
	});
});

describe("each exit", () => {
	it("refuses a body write as permissionDecision JSON on exit 0, splicing the stored rule", () => {
		const out = emission('gh issue edit 132 --body "new text"');
		expect(out.hookEventName).toBe("PreToolUse");
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toBe(
			`This writes an issue body whole, erasing any parallel session's edit: gh issue edit 132 --body "…"\n\n${readRuleText("issue-body-clobber")}`,
		);
		expect(readFailOpenRecords(config, dir)).toEqual([]);
	});

	it("still refuses, naming the fragment, where the rule store cannot give it", () => {
		const out = emission('gh issue edit 132 --body "x"', {
			env: { WFC_RULES_DIR: fs.mkdtempSync(path.join(dir, "store-")) },
		});
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(
			"docs/agents/rules/issue-body-clobber.txt",
		);
	});

	it("warns, as additionalContext on exit 0, on a PATCH whose fields it cannot read (mantahostels#103)", () => {
		const out = emission(
			"gh api --method PATCH repos/o/r/issues/96 --input payload.json",
		);
		expect(out.permissionDecision).toBeUndefined();
		expect(out.additionalContext).toContain(
			"This PATCHes an issue resource directly, and the guard cannot see whether it writes the body:",
		);
	});

	it("names the helper at the plugin root in an install, WFC_SCRIPT_ROOT standing in for one (#1248)", () => {
		const plugin = fs.mkdtempSync(path.join(dir, "plugin-"));
		fs.mkdirSync(path.join(plugin, "scripts"));
		fs.writeFileSync(path.join(plugin, "scripts", "issue-body.js"), "");
		const out = emission("gh api graphql --input payload.json", {
			env: { WFC_SCRIPT_ROOT: plugin },
		});
		expect(out.additionalContext).toContain(
			`  node ${plugin}/scripts/issue-body.js append <n> --text "…"`,
		);
	});

	it("says nothing about a comment or a field-only edit, and judges the command, not the cwd", () => {
		expect(emission('gh issue comment 96 --body "x"')).toBeNull();
		expect(emission("gh issue edit 96 --add-label kind:ticket")).toBeNull();
		const elsewhere = fs.mkdtempSync(path.join(dir, "elsewhere-"));
		expect(
			emission("gh issue edit 96 --body x", { cwd: elsewhere })
				.permissionDecision,
		).toBe("deny");
		expect(readFailOpenRecords(config, dir)).toEqual([]);
	});

	it("refuses, logged, where its core throws", () => {
		const out = guardOutput(
			entryBesideThrowingCore(dir, SCRIPT, "issue-body-write.js"),
			buildBashPayload(
				"gh api --method PATCH repos/o/r/issues/96 -f body=x",
				"s1",
			),
			{ project: dir, config, cwd: dir },
		);
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toBe(
			"guard-issue-body.js could not judge this command, so it refuses it: broke",
		);
		expect(readFailOpenLog(config, dir)).toMatch(
			/core threw — the command was refused\tbroke/,
		);
	});
});

describe("what it fails open on", () => {
	it("allows a payload that is not JSON, and records that it did", () => {
		expect(emission("", { stdin: "not json" })).toBeNull();
		expect(readFailOpenRecords(config, dir)).toEqual([
			[
				expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
				"guard-issue-body.js",
				expect.stringContaining("payload did not parse as JSON"),
			],
		]);
	});

	it("allows a payload carrying no command, and records that it did", () => {
		expect(
			emission("", {
				stdin: JSON.stringify({ session_id: "s1", tool_name: "Bash" }),
			}),
		).toBeNull();
		expect(readFailOpenRecords(config, dir).map((f) => f[2])).toEqual([
			expect.stringContaining("no command in payload"),
		]);
	});

	it("fails open, exit 0 and silent, where node is not on PATH", () => {
		expect(
			emission('gh issue edit 96 --body "x"', {
				env: { PATH: "/nonexistent" },
			}),
		).toBeNull();
	});
});
