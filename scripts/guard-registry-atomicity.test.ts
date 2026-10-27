// @vitest-environment node
/*
 * guard-registry-atomicity.js refuses a commit landing a registry member
 * without its wiring (mantahostels#2671). These are its boundary cases: the
 * line hooks/hooks.json registers, run by bash as the harness runs it, on a
 * harness-shaped payload against a fixture repo — the wiring, the exit and
 * its stream, the fail-open record on disk, and git crossed for real and at
 * WFC_GIT.
 *
 * CLAUDE_PLUGIN_ROOT is this checkout, so the line finds the real entry;
 * CLAUDE_PROJECT_DIR is the fixture repo, so its fail-open log lands in the
 * temp CLAUDE_CONFIG_DIR and never the founder's.
 *
 * Break the line and a member lands without its wiring, reddening the
 * whole-repo registry tests for every session; make it deny on a fault and
 * every commit is wedged.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFailOpenRecords } from "./guard-log-fixture";
import { defineTemplate, initGitRepo, mkScratchDir } from "./lib/git-fixture";
import {
	expectShellHooks,
	hookLineOutput,
	readHookLines,
} from "./lib/pretool-guard-testkit";

const SCRIPT = "scripts/guard-registry-atomicity.js";
const LINES = readHookLines("hooks/hooks.json", SCRIPT);
const SELF_LINES = readHookLines("self-plugin/hooks/hooks.json", SCRIPT);

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A repo whose four registries are wired and green, one checker among them. */
const template = defineTemplate((root) => {
	const hooks = path.join(root, "no-hooks");
	fs.mkdirSync(hooks);
	const repo = path.join(root, "repo");
	initGitRepo(repo, hooks);
	const write = (rel: string, body: string) => {
		fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
		fs.writeFileSync(path.join(repo, rel), body);
	};
	write(
		"self-plugin/hooks/hooks.json",
		`${JSON.stringify({ hooks: { PreToolUse: [] } })}\n`,
	);
	write("scripts/guard-fire-needles.json", '{ "guards": {} }\n');
	write(
		"scripts/hook-registrations.test.ts",
		"const REGISTERED_ELSEWHERE = {};\n",
	);
	write(
		"scripts/checker-registrations.test.ts",
		"const CALLED_ELSEWHERE = {};\n",
	);
	write("scripts/README.md", "# fixture\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "wiring");
});

let dir: string;
let repo: string;
let config: string;

beforeEach(() => {
	dir = mkScratchDir("registry-atomicity-entry-");
	template.instantiate(dir);
	repo = path.join(dir, "repo");
	config = path.join(dir, "config");
	fs.mkdirSync(config);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Give the repo a new, unwired checker, intent-added so a pathspec reaches it. */
function addUnwiredChecker(): void {
	fs.writeFileSync(path.join(repo, "scripts", "check-new.js"), "// new\n");
	git(repo, "add", "-N", "--", "scripts/check-new.js");
}

/** The hook's hookSpecificOutput for `command`, run in the fixture repo. */
const emission = (
	command: string,
	run: { stdin?: string; env?: NodeJS.ProcessEnv } = {},
) =>
	hookLineOutput(LINES[0] ?? "", command, {
		project: repo,
		config,
		cwd: repo,
		...run,
	});

describe("the registered hook line", () => {
	it("is one line on both `if` narrowings, in the plugin and the self-plugin alike", () => {
		expect(LINES).toHaveLength(2);
		expect(new Set(LINES).size).toBe(1);
		expect(SELF_LINES).toHaveLength(2);
		expect(new Set(SELF_LINES).size).toBe(1);
	});

	it("is shell form, carrying no `args` key, so the harness runs it through a shell (mantahostels#2059)", () => {
		expectShellHooks(SCRIPT, () => ({ onFailure: "block" }), 2);
	});

	it("refuses a commit landing an unwired checker as permissionDecision JSON on exit 0, recording no fault", () => {
		addUnwiredChecker();
		const out = emission('git commit -m "x" -- scripts/check-new.js');
		expect(out.hookEventName).toBe("PreToolUse");
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(
			"scripts/check-new.js is a new checker, and this commit does not carry its wiring",
		);
		expect(out.permissionDecisionReason).toContain(
			"Why this is a refusal and not a warning",
		);
		expect(out.permissionDecisionReason).toContain(
			"add a commented CALLED_ELSEWHERE entry to scripts/checker-registrations.test.ts in THIS commit instead",
		);
		expect(readFailOpenRecords(config, repo)).toEqual([]);
	});

	it("refuses the same commit made through commit-paths.js, the form CLAUDE.md requires (#1727)", () => {
		fs.writeFileSync(path.join(repo, "scripts", "check-new.js"), "// new\n");
		const out = emission(
			'node scripts/commit-paths.js -m "x" -- scripts/check-new.js',
		);
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(
			"scripts/check-new.js is a new checker, and this commit does not carry its wiring",
		);
	});

	it("says nothing about a commit landing no member", () => {
		fs.writeFileSync(path.join(repo, "scripts", "README.md"), "# edited\n");
		expect(emission('git commit -m "x" -- scripts/README.md')).toBeNull();
		expect(readFailOpenRecords(config, repo)).toEqual([]);
	});

	it("allows a payload carrying no command, and records that it did", () => {
		addUnwiredChecker();
		expect(
			emission("", {
				stdin: JSON.stringify({ session_id: "s1", tool_name: "Bash" }),
			}),
		).toBeNull();
		expect(readFailOpenRecords(config, repo)).toEqual([
			[
				expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
				"guard-registry-atomicity.js",
				expect.stringContaining("no command in payload"),
			],
		]);
	});

	it("reads git at WFC_GIT, and allows a commit whose staged list it cannot read, recording that it did", () => {
		addUnwiredChecker();
		git(repo, "add", "--", "scripts/check-new.js");
		const bin = fs.mkdtempSync(path.join(dir, "shim-"));
		const real = execFileSync("bash", ["-c", "command -v git"], {
			encoding: "utf8",
		}).trim();
		fs.writeFileSync(
			path.join(bin, "git"),
			`#!/usr/bin/env bash\nfor a in "$@"; do [[ "$a" == diff ]] && exit 128; done\nexec ${JSON.stringify(real)} "$@"\n`,
			{ mode: 0o755 },
		);
		expect(
			emission('git commit -m "x"', {
				env: { WFC_GIT: path.join(bin, "git") },
			}),
		).toBeNull();
		expect(readFailOpenRecords(config, repo).map((f) => f[2])).toEqual([
			`git could not read the staged path list in ${repo} — that commit was allowed unchecked`,
		]);
	});

	it("fails open, exit 0 and silent, where node is not on PATH", () => {
		addUnwiredChecker();
		expect(
			emission('git commit -m "x" -- scripts/check-new.js', {
				env: { PATH: "/nonexistent" },
			}),
		).toBeNull();
	});
});
