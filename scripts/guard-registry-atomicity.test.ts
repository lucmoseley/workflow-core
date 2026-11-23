// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFailOpenRecords } from "./guard-log-fixture";
import { coreFile } from "./lib/core-path-testkit";
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

function addUnwiredChecker(): void {
	fs.writeFileSync(path.join(repo, "scripts", "check-new.js"), "// new\n");
	git(repo, "add", "-N", "--", "scripts/check-new.js");
}

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
			`add a commented CALLED_ELSEWHERE entry to ${coreFile("scripts/checker-registrations.test.ts")} in THIS commit instead`,
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

	it.each([
		["a timeout lead", "timeout 30 git commit -m x -- scripts/check-new.js"],
		["an env lead", "env A=1 git commit -m x -- scripts/check-new.js"],
		[
			"an xargs writing the path out",
			"echo | xargs git commit -m x -- scripts/check-new.js",
		],
		[
			"a flock -c string behind another command",
			"git status; flock /tmp/l -c 'true; git commit -m x -- scripts/check-new.js'",
		],
	])("refuses the hand commit wrapped in %s (#4879)", (_, command) => {
		addUnwiredChecker();
		const out = emission(command);
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(
			"scripts/check-new.js is a new checker, and this commit does not carry its wiring",
		);
	});

	it.each([
		["sh -c", 'sh -c "git commit -m x -- scripts/check-new.js"'],
		[
			"a launcher outside WRAPPERS (chrt)",
			"chrt 1 git commit -m x -- scripts/check-new.js",
		],
	])(
		"leaves a hand commit behind %s unjudged, as LIMITS says",
		(_, command) => {
			addUnwiredChecker();
			expect(emission(command)).toBeNull();
		},
	);

	it.each([
		["a commit", 'git commit -m "x" -- scripts/README.md'],
		["a wrapped commit", "timeout 30 git commit -m x -- scripts/README.md"],
	])("says nothing about %s landing no member", (_, command) => {
		fs.writeFileSync(path.join(repo, "scripts", "README.md"), "# edited\n");
		expect(emission(command)).toBeNull();
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
