// @vitest-environment node
/*
 * scripts/post-commit-dispatch.js and lib/post-commit-rows.js (#5208, spec
 * #5207).
 *
 * Breaking it costs every after-commit notice, release and record at once:
 * the hook's one line runs them all.
 *
 * spawn-kept: the boundary cases commit in a temp repo so git itself fires
 * the real hook, which is the process boundary under test.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROWS } from "./lib/post-commit-rows.js";
import {
	hookEnv,
	linkedCommit,
	programs,
	quietPrograms,
	runPostCommit,
	SILENT,
	STEPS,
	stubProgram,
} from "./lib/post-commit-testkit";
import { newRepo, registerTempCleanup } from "./lib/precommit-gate-harness";

const temps = registerTempCleanup();
const ROOT = path.join(__dirname, "..");

const tmp = (prefix: string) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	temps.push(dir);
	return dir;
};

describe("the registry", () => {
	it("runs the eight steps in the hook's order, the five that would misread a replay gated on the stand-down set", () => {
		expect(
			ROWS.map((r) => [r.id, r.policy, r.when?.unlessRoutes ?? null]),
		).toEqual([
			["unpushed-report", "warn", null],
			["new-shared-faults", "warn", ["post-commit-stand-down"]],
			["instruction-surface", "warn", ["post-commit-stand-down"]],
			["guard-registry", "warn", ["post-commit-stand-down"]],
			["claim-release", "warn", ["post-commit-stand-down"]],
			["commit-record", "warn", ["post-commit-stand-down"]],
			["hook-shims", "warn", null],
			["dropped-review-tier", "warn", null],
		]);
	});

	it("runs the hook-shim keeper lazily, its streams passed through", () => {
		const repo = newRepo("post-commit-shims-", temps);
		repo.git("commit", "-q", "--allow-empty", "-m", "one");
		const keeper = stubProgram("keep-hook-shims.js", () => ({
			exit: 1,
			stdout: "kept\n",
			stderr: "a shim\n",
		}));
		const row = ROWS.find((r) => r.id === "hook-shims");
		expect(row?.run).toBe(STEPS.keepShimsRow);

		expect(
			STEPS.keepShimsRow({ cwd: repo.root, env: hookEnv() }, programs),
		).toEqual({
			exit: 0,
			stdout: "kept\n",
			stderr: "a shim\n",
		});
		expect(keeper.mock.calls[0][0].args).toEqual(["--lazy"]);
	});

	it("reads a linked worktree's commit under the redirects git hands its hook, handing no program those redirects and leaving this process as it was", async () => {
		const repo = newRepo("post-commit-linked-", temps);
		repo.git("commit", "-q", "--allow-empty", "-m", "one");
		const { wt, env, redirects } = linkedCommit(repo.root, tmp("linked-"));
		expect(redirects.GIT_INDEX_FILE).toBeTruthy();
		execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD~1"], {
			cwd: wt,
		});
		const quiet = quietPrograms();
		const before = { cwd: process.cwd(), env: { ...process.env } };

		const r = await runPostCommit({
			cwd: wt,
			env: { ...env, CLAUDE_CODE_SESSION_ID: "s1" },
		});

		expect(r).toEqual({
			exit: 0,
			stdout: "\u001b[33m!\u001b[0m 1 commit not pushed to origin/main.\n",
			stderr: "",
		});
		const handed = [
			quiet["report-new-shared-faults.js"],
			quiet["session-arbiter.js"],
			quiet["keep-hook-shims.js"],
		].flatMap((spy) => spy.mock.calls.map((c) => c[0].env));
		expect(handed).toHaveLength(4);
		for (const e of handed)
			for (const k of ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE"])
				expect(e[k], k).toBeUndefined();
		expect(quiet.check).toHaveBeenCalledTimes(2);
		expect(process.cwd()).toBe(before.cwd);
		expect(process.env).toEqual(before.env);
		expect(STEPS.droppedReviewTier({ cwd: wt, env })).toEqual(SILENT);
	});
});

describe("the real .husky/post-commit, as git fires it", () => {
	function hookedRepo(pluginRoot = ROOT) {
		const dir = tmp("post-commit-hook-");
		const repo = newRepo("post-commit-hook-repo-", temps);
		repo.git("commit", "-q", "--allow-empty", "-m", "base");
		repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
		const hooks = path.join(dir, "hooks");
		fs.mkdirSync(hooks);
		fs.copyFileSync(
			path.join(ROOT, ".husky", "post-commit"),
			path.join(hooks, "post-commit"),
		);
		fs.chmodSync(path.join(hooks, "post-commit"), 0o755);
		repo.git("config", "core.hooksPath", hooks);
		const ran = path.join(dir, "ran");
		const checker = path.join(dir, "checker.js");
		fs.writeFileSync(
			checker,
			`require("node:fs").appendFileSync(${JSON.stringify(ran)}, "ran\\n");\nprocess.stdout.write('{"findings":[]}');\n`,
		);
		const config = path.join(dir, "claude-home");
		fs.mkdirSync(config);
		const { CLAUDE_CODE_SESSION_ID: _, ...inherited } = process.env;
		const env: NodeJS.ProcessEnv = {
			...inherited,
			WFC_PLUGIN_ROOT: pluginRoot,
			CLAUDE_CONFIG_DIR: config,
			WFC_SHARED_FAULT_CHECKERS: JSON.stringify({ "guard-registry": checker }),
		};
		const git = (...args: string[]) =>
			spawnSync("git", args, { cwd: repo.root, encoding: "utf8", env });
		const ranCount = () =>
			fs.existsSync(ran)
				? fs.readFileSync(ran, "utf8").split("\n").length - 1
				: 0;
		return { root: repo.root, git, ranCount, dir };
	}

	it("prints the unpushed count after a commit, and runs the gated steps", () => {
		const repo = hookedRepo();

		const r = repo.git("commit", "-q", "--allow-empty", "-m", "mine");

		expect(r.status).toBe(0);
		// git hands a hook's stdout to its own stderr.
		expect(r.stderr).toContain(
			"\u001b[33m!\u001b[0m 1 commit not pushed to origin/main.\n",
		);
		expect(repo.ranCount(), "the fault notice ran its checker").toBeGreaterThan(
			0,
		);
	});

	it("stands the gated steps down on a cherry-pick while the unpushed count still prints", () => {
		const repo = hookedRepo();
		repo.git("checkout", "-q", "-b", "side");
		fs.writeFileSync(path.join(repo.root, "picked.txt"), "x\n");
		repo.git("add", "picked.txt");
		repo.git("commit", "-q", "-m", "to pick");
		const picked = repo.git("rev-parse", "HEAD").stdout.trim();
		repo.git("checkout", "-q", "-");
		const before = repo.ranCount();

		const r = repo.git("cherry-pick", picked);

		expect(r.status).toBe(0);
		expect(r.stderr + r.stdout).toContain(
			"1 commit not pushed to origin/main.",
		);
		expect(repo.ranCount(), "the fault notice stood down").toBe(before);
	});

	it("says in one line that it ran nothing where the plugin has no dispatcher, and the commit lands", () => {
		const plugin = tmp("post-commit-plugin-");
		fs.mkdirSync(path.join(plugin, "scripts"));
		fs.symlinkSync(
			path.join(ROOT, "scripts", "lib"),
			path.join(plugin, "scripts", "lib"),
		);
		const repo = hookedRepo(plugin);
		const head = repo.git("rev-parse", "HEAD").stdout;

		const r = repo.git("commit", "-q", "--allow-empty", "-m", "mine");

		expect(r.status).toBe(0);
		expect(r.stderr).toBe(
			`post-commit: ${plugin}/scripts/post-commit-dispatch.js is missing, so no after-commit report, release or record ran.\n`,
		);
		expect(repo.git("rev-parse", "HEAD").stdout).not.toBe(head);
	});
});
