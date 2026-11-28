// @vitest-environment node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineTemplate, initGitRepo } from "./git-fixture";
import { isGroupDead } from "./process-fixture";

const ROOT = path.join(__dirname, "..", "..");
const SOURCE_LINE = `[ ! -r "\${WFC_PLUGIN_ROOT:-$(dirname "$0")/..}/scripts/lib/hook-bound.sh" ] || . "\${WFC_PLUGIN_ROOT:-$(dirname "$0")/..}/scripts/lib/hook-bound.sh"`;
const HOOKS = [
	".husky/pre-commit",
	".husky/prepare-commit-msg",
	".husky/commit-msg",
	".husky/post-commit",
	".husky/post-merge",
	".husky/post-checkout",
	".husky/pre-push",
];
// guess, #4187
const HOOK_RUN_TIMEOUT_MS = 60_000;
// guess, #4187
const REAP_TIMEOUT_MS = 5000;

// guess, #4187
const SLEEPER_S = 30;
const LOOP_SOURCE = `const { spawn } = require("node:child_process");
spawn("sleep", ["${SLEEPER_S}"], { stdio: "ignore" });
process.stdout.write(process.pid + "\\n");
for (;;) {}
`;

let dir = "";
let loop = "";
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-bound-"));
	loop = path.join(dir, "loop-checker.js");
	fs.writeFileSync(loop, LOOP_SOURCE);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const boundEnv = (pluginRoot: string) => ({
	...process.env,
	WFC_PLUGIN_ROOT: pluginRoot,
	WFC_HOOK_LIMIT_S: "1",
});

function runHook(name: string, body: string, prelude = "") {
	const hook = path.join(dir, name);
	fs.writeFileSync(
		hook,
		`#!/usr/bin/env sh\nset -e\n${prelude}${SOURCE_LINE}\n${body}\n`,
	);
	return spawnSync("sh", ["-e", hook], {
		encoding: "utf8",
		env: boundEnv(ROOT),
		timeout: HOOK_RUN_TIMEOUT_MS,
	});
}

async function expectGroupDead(pgid: number) {
	await vi.waitFor(() => expect(isGroupDead(pgid)).toBe(true), {
		timeout: REAP_TIMEOUT_MS,
	});
}

describe("a checker that never returns (#4187)", () => {
	it("is killed with its children, named, and fails pre-commit", async () => {
		const r = runHook("pre-commit", `node "${loop}" || exit "$?"\necho PASSED`);
		expect(r.status).not.toBe(0);
		expect(r.stdout).not.toContain("PASSED");
		expect(r.stderr).toContain(
			`pre-commit: ${loop} ran past its 1 s limit, so it and every process it started are killed (#4187).`,
		);
		await expectGroupDead(Number(r.stdout.trim()));
	});

	it("is named where its call site discards its stderr", () => {
		const r = runHook(
			"pre-commit",
			`out=$(node "${loop}" 2>/dev/null) || exit "$?"`,
		);
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain(`pre-commit: ${loop} ran past its 1 s limit`);
	});

	it("is killed under `bash` and under a hook_bound binary", () => {
		const script = path.join(dir, "loop.sh");
		fs.writeFileSync(script, "while :; do :; done\n");
		for (const line of [
			`bash "${script}" || exit "$?"`,
			`hook_bound sh "${script}" || exit "$?"`,
		]) {
			const r = runHook("pre-commit", line);
			expect(r.status).not.toBe(0);
			expect(r.stderr).toContain(
				`pre-commit: ${script} ran past its 1 s limit`,
			);
		}
	});

	it("is killed and reported by the real post-commit, which then returns", () => {
		const plugin = path.join(dir, "plugin");
		fs.mkdirSync(path.join(plugin, "scripts"), { recursive: true });
		fs.symlinkSync(
			path.join(ROOT, "scripts", "lib"),
			path.join(plugin, "scripts", "lib"),
		);
		const dispatcher = path.join(plugin, "scripts", "post-commit-dispatch.js");
		fs.writeFileSync(dispatcher, LOOP_SOURCE);
		const repo = path.join(dir, "repo");
		const hooks = path.join(dir, "no-hooks");
		fs.mkdirSync(hooks);
		initGitRepo(repo, hooks);
		const env: NodeJS.ProcessEnv = boundEnv(plugin);
		delete env.CLAUDE_CODE_SESSION_ID;
		delete env.CLAUDE_PROJECT_DIR;
		const r = spawnSync("sh", [path.join(ROOT, ".husky", "post-commit")], {
			cwd: repo,
			encoding: "utf8",
			env,
			timeout: HOOK_RUN_TIMEOUT_MS,
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(
			`post-commit: ${dispatcher} ran past its 1 s limit`,
		);
	});
});

describe("prepare-commit-msg's steps (#5213)", () => {
	const repoTemplate = defineTemplate((root) => initGitRepo(root, ".no-hooks"));

	const sleeper = `() => require("node:child_process").spawnSync("sleep", ["${SLEEPER_S}"])`;
	const hung = (name: string) => `module.exports = { ${name}: ${sleeper} };\n`;
	const hungSpec = `module.exports = { SPEC: { name: "hung", usage: "hung", run: ${sleeper} } };\n`;
	const SlowPreCommit = "sleep 2\necho PRE-COMMIT-DONE\n";

	const PrepareCommitMsgScripts = [
		"lib",
		"prepare-commit-msg-dispatch.js",
		"check-commit-message-closes.js",
		"review-hold-gate.js",
		"review-tier-trailer.js",
	];

	function prepareCommitMsg(
		preCommit: string,
		message: string,
		steps: Record<string, string>,
		gitDirFiles: string[] = [],
	) {
		const scripts = path.join(dir, "plugin", "scripts");
		fs.mkdirSync(scripts, { recursive: true });
		for (const name of PrepareCommitMsgScripts)
			if (steps[name] === undefined)
				fs.symlinkSync(
					path.join(ROOT, "scripts", name),
					path.join(scripts, name),
				);
		for (const [name, text] of Object.entries(steps))
			fs.writeFileSync(path.join(scripts, name), text);
		const husky = path.join(dir, "husky");
		fs.mkdirSync(husky);
		fs.copyFileSync(
			path.join(ROOT, ".husky", "prepare-commit-msg"),
			path.join(husky, "prepare-commit-msg"),
		);
		fs.writeFileSync(path.join(husky, "pre-commit"), preCommit);
		const repo = path.join(dir, "repo");
		repoTemplate.instantiate(repo);
		for (const name of gitDirFiles)
			fs.writeFileSync(path.join(repo, ".git", name), "HEAD\n");
		const file = path.join(dir, "COMMIT_EDITMSG");
		fs.writeFileSync(file, message);
		const env: NodeJS.ProcessEnv = {
			...boundEnv(path.join(dir, "plugin")),
			WFC_GITLEAKS: "true",
		};
		delete env.CLAUDE_CODE_SESSION_ID;
		delete env.CLAUDE_PROJECT_DIR;
		return spawnSync("sh", [path.join(husky, "prepare-commit-msg"), file], {
			cwd: repo,
			encoding: "utf8",
			env,
			timeout: HOOK_RUN_TIMEOUT_MS,
		});
	}

	const killedLine = () =>
		`prepare-commit-msg: ${path.join(dir, "plugin", "scripts", "prepare-commit-msg-dispatch.js")} ran past its 1 s limit`;

	it("refuses a commit whose closing-keyword scan hangs, killed at the limit", () => {
		const r = prepareCommitMsg("exit 0\n", "subject\n", {
			"check-commit-message-closes.js": hungSpec,
		});
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain(killedLine());
	});

	it("refuses a cherry-pick whose review hold hangs, killed at the limit", () => {
		const r = prepareCommitMsg(
			"exit 0\n",
			"subject\n",
			{ "review-hold-gate.js": hung("PROGRAM") },
			["CHERRY_PICK_HEAD"],
		);
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain(killedLine());
	});

	it("does not time the inline pre-commit", () => {
		const r = prepareCommitMsg(SlowPreCommit, "subject\n", {});
		expect(r.stderr).not.toContain("ran past its");
		expect(r.stdout).toContain("PRE-COMMIT-DONE");
		expect(r.status).toBe(0);
	});

	it("times the trailer after the inline pre-commit, the clock resumed", () => {
		const r = prepareCommitMsg(
			SlowPreCommit,
			"subject\n\nReview-Tier: light\n",
			{ "review-tier-trailer.js": hung("PROGRAM") },
		);
		expect(r.stdout).toContain("PRE-COMMIT-DONE");
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain(killedLine());
	});
});

describe("a checker inside the limit (#4187)", () => {
	it("keeps its own status, output and stdin", () => {
		const r = runHook(
			"pre-push",
			`printf 'refs\\n' | node -e 'process.stdin.pipe(process.stdout); process.stdin.on("end", () => process.exit(3))' || echo "status $?"`,
		);
		expect(r.stdout).toBe("refs\nstatus 3\n");
		expect(r.stderr).toBe("");
	});

	it("gets no pause pipe unless its hook asks for one (#5213)", () => {
		const probe = `node -e 'process.stdout.write(String(process.env.WFC_HOOK_PAUSE_FD))'`;
		expect(runHook("pre-commit", probe).stdout).toBe("undefined");
		expect(runHook("prepare-commit-msg", probe, "hb_pausable=1\n").stdout).toBe(
			"3",
		);
	});

	it("runs unbounded, `node` the binary, where the runner is missing", () => {
		const r = spawnSync(
			"sh",
			[
				"-ec",
				`. "${ROOT}/scripts/lib/hook-bound.sh"; command -v node; hook_bound echo RAN`,
			],
			{ encoding: "utf8", env: { ...process.env, WFC_PLUGIN_ROOT: dir } },
		);
		expect(r.stdout).toMatch(/^\/.*node\nRAN\n$/);
	});
});

describe("the hooks (#4187)", () => {
	it.each(HOOKS)("%s sources the library", (name) => {
		const hook = fs.readFileSync(path.join(ROOT, name), "utf8");
		expect(hook).toContain(SOURCE_LINE);
	});

	it.each(HOOKS)("%s starts no node or bash through env", (name) => {
		const hook = fs.readFileSync(path.join(ROOT, name), "utf8");
		expect(hook).not.toMatch(/\benv\b[^\n#]*(\\\n[^\n]*)*\b(node|bash) /);
	});
});
