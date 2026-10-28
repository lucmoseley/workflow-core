// @vitest-environment node
/*
 * The guard-registry-atomicity core of guard-dispatch.js refuses a commit
 * landing a registry member without its wiring (mantahostels#2671). These are
 * its boundary cases, the dispatcher entry run on it alone, on a
 * harness-shaped payload against a fixture repo: the wiring, the exit and its
 * stream, the fail-open record on disk, and git crossed for real and at
 * WFC_GIT. The entry's payload faults and the throw policy are
 * guard-dispatch's own tests' (#3226).
 *
 * CLAUDE_PROJECT_DIR is the fixture repo, so its fail-open log lands in the
 * temp CLAUDE_CONFIG_DIR and never the founder's.
 *
 * Break the core and a member lands without its wiring, reddening the
 * whole-repo registry tests for every session; make it deny on a fault and
 * every commit is wedged.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFailOpenRecords } from "./guard-log-fixture";
import { writeFaultyGit } from "./lib/git-fault-fake";
import { defineTemplate, initGitRepo, mkScratchDir } from "./lib/git-fixture";
import {
	buildBashPayload,
	dispatchCoreOutput,
} from "./lib/pretool-guard-testkit";

const CORE = "guard-registry-atomicity";

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

/** The core's hookSpecificOutput for `command`, run in the fixture repo. */
const emission = (command: string, run: { env?: NodeJS.ProcessEnv } = {}) =>
	dispatchCoreOutput(CORE, buildBashPayload(command, "s1"), {
		project: repo,
		config,
		cwd: repo,
		...run,
	});

describe("the registry-atomicity core", () => {
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

	it("reads git at WFC_GIT, and allows a commit whose staged list it cannot read, recording that it did", () => {
		addUnwiredChecker();
		git(repo, "add", "--", "scripts/check-new.js");
		const { git: failing } = writeFaultyGit(
			{ words: ["diff"] },
			{ exit: 128 },
			{ under: dir },
		);
		expect(
			emission('git commit -m "x"', {
				env: { WFC_GIT: failing },
			}),
		).toBeNull();
		expect(readFailOpenRecords(config, repo).map((f) => f[2])).toEqual([
			`git could not read the staged path list in ${repo} — that commit was allowed unchecked`,
		]);
	});
});
