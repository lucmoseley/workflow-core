// @vitest-environment node
/*
 * scripts/lib/hook-bound.sh — every checker a git hook runs, bounded by one
 * wall-clock limit (#4187). A checker that never returns is killed with
 * everything it started, named on the hook's own stderr even where the call
 * site discards the checker's, and fails pre-commit; post-commit reports it
 * and returns.
 *
 * Each hung-checker case runs the REAL library against a checker that never
 * returns, under a 1 s limit, crossing the real clock: no injected clock
 * reaches a real process group's kill. prepare-commit-msg's cases run the
 * real hook and dispatcher, each in its own Node start, and a pre-commit
 * that outlasts the limit: most of the file's time (#5213).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineTemplate, initGitRepo } from "./git-fixture";
import { isGroupDead } from "./process-fixture";

const ROOT = path.join(__dirname, "..", "..");
const SOURCE_LINE =
	// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
	'[ ! -r "${WFC_PLUGIN_ROOT:-$(dirname "$0")/..}/scripts/lib/hook-bound.sh" ] || . "${WFC_PLUGIN_ROOT:-$(dirname "$0")/..}/scripts/lib/hook-bound.sh"';
/* pre-merge-commit starts no checker of its own: it runs pre-commit, which
 * sources the library. pre-applypatch's one `node`, its refusal printer,
 * runs unbounded. */
const HOOKS = [
	".husky/pre-commit",
	".husky/prepare-commit-msg",
	".husky/commit-msg",
	".husky/post-commit",
	".husky/post-merge",
	".husky/post-checkout",
	".husky/pre-push",
];
/* Untraced: far past the 1 s limit plus run-budgeted.js's 10 s KILL grace, so
 * only a kill that never comes reaches it. */
const HOOK_RUN_TIMEOUT_MS = 60_000;
/* Untraced: the kernel reaps on its own clock. */
const REAP_TIMEOUT_MS = 5000;

/* Untraced: far past the 1 s limit, so a sleeper outliving it is unkilled. */
const SLEEPER_S = 30;
/* Prints its pid, the group's leader, starts a sleeper in it, then spins. */
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

function runHook(name: string, body: string) {
	const hook = path.join(dir, name);
	fs.writeFileSync(
		hook,
		`#!/usr/bin/env sh\nset -e\n${SOURCE_LINE}\n${body}\n`,
	);
	// spawn-kept: a timeout — the library's limit kills a real process group
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
		// spawn-kept: a timeout — the library's limit kills a real process group
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

	/* A step whose export never returns, waiting on a child as a hung step
	 * does: the limit's TERM ends it, where a spin would wait out the 10 s
	 * KILL grace. */
	const hung = (name: string) =>
		`module.exports = { ${name}: () => require("node:child_process").spawnSync("sleep", ["${SLEEPER_S}"]) };\n`;
	/* Past the 1 s limit, so only a stopped clock lets it finish. */
	const SlowPreCommit = "sleep 2\necho PRE-COMMIT-DONE\n";

	/* What .husky/prepare-commit-msg reaches under the plugin root. */
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
		/* Named, not the whole of scripts/, so this file reads only what it runs. */
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
		// spawn-kept: a timeout — the library's limit kills a real process group
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
			"check-commit-message-closes.js": hung("main"),
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
		/* A Review-Tier: line arms the trailer. */
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
		expect(
			runHook(
				"prepare-commit-msg",
				`hb_pausable=1\n. "${ROOT}/scripts/lib/hook-bound.sh"\n${probe}`,
			).stdout,
		).toBe("3");
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

	/* `env <var>… node` runs the binary past the function, unbounded. */
	it.each(HOOKS)("%s starts no node or bash through env", (name) => {
		const hook = fs.readFileSync(path.join(ROOT, name), "utf8");
		expect(hook).not.toMatch(/\benv\b[^\n#]*(\\\n[^\n]*)*\b(node|bash) /);
	});
});
