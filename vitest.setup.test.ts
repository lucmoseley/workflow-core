// @vitest-environment node
/*
 * Pins vitest.setup.ts's per-file Claude config dir: a test case sees a temp
 * dir, not the one the runner started with.
 *
 * It compares against /proc/self/environ, which holds the environment the
 * worker started with and which no later write to `process.env` changes, so it
 * reads the runner's value rather than the override.
 *
 * Breaking it lets tests write arbiter state and caches into the founder's
 * live ~/.claude* again (#838).
 *
 * Also pins its removal of git's repository-locating variables (#1677).
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initGitRepo } from "./scripts/lib/git-fixture";

const readStartedEnv = (name: string) =>
	fs
		.readFileSync("/proc/self/environ", "utf8")
		.split("\0")
		.find((entry) => entry.startsWith(`${name}=`))
		?.slice(name.length + 1);

describe("the Claude config dir a test case sees", () => {
	it.runIf(fs.existsSync("/proc/self/environ"))(
		"is not the one the runner was started with",
		() => {
			expect(process.env.CLAUDE_CONFIG_DIR).not.toBe(
				readStartedEnv("CLAUDE_CONFIG_DIR"),
			);
		},
	);

	it("is a directory under the OS temp dir", () => {
		const dir = process.env.CLAUDE_CONFIG_DIR ?? "";
		expect(dir.startsWith(os.tmpdir() + path.sep)).toBe(true);
		expect(fs.statSync(dir).isDirectory()).toBe(true);
	});
});

/*
 * #1677: a run started under a linked worktree's exported `GIT_DIR` — a hook,
 * `git bisect run` — must not let a fixture's plain `git init <dir>` mark the
 * worktree's main repo bare. Driven through a nested vitest run loading the real setup
 * file, since the variables have to be set before the worker starts.
 */
const GIT_LOCATORS = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_PREFIX",
];

describe("a run started under a worktree's exported git variables (#1677)", () => {
	const repoRoot = path.dirname(fileURLToPath(import.meta.url));
	let dir: string;
	let gitDir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-git-env-"));
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: dir, stdio: "pipe" });
		const hooks = path.join(dir, "no-hooks");
		fs.mkdirSync(hooks);
		initGitRepo(path.join(dir, "scratch"), hooks);
		git("-C", "scratch", "worktree", "add", "-q", "--detach", "../wt");
		gitDir = path.join(dir, "scratch", ".git", "worktrees", "wt");
		fs.writeFileSync(
			path.join(dir, "probe.test.ts"),
			`import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
test("probe", () => {
	const out = process.env.PROBE_OUT as string;
	execFileSync("git", ["init", "-q", path.join(out, "fresh")]);
	const names = Object.keys(process.env).filter((k) => k.startsWith("GIT_"));
	fs.writeFileSync(path.join(out, "env.json"), JSON.stringify(names));
});
`,
		);
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	/** Runs the probe with `leaked` set, and returns the `GIT_*` names its worker saw. */
	const runProbe = (leaked: Record<string, string>, withSetup = true) => {
		const out = fs.mkdtempSync(path.join(dir, "out-"));
		const config = path.join(dir, "probe.config.mts");
		fs.writeFileSync(
			config,
			`export default ${JSON.stringify({
				test: {
					root: dir,
					include: ["probe.test.ts"],
					globals: true,
					environment: "node",
					setupFiles: withSetup ? [path.join(repoRoot, "vitest.setup.ts")] : [],
				},
			})};\n`,
		);
		const r = spawnSync(
			process.execPath,
			[
				path.join(repoRoot, "node_modules/vitest/vitest.mjs"),
				"run",
				"--config",
				config,
			],
			{
				cwd: dir,
				encoding: "utf8",
				env: { ...process.env, ...leaked, PROBE_OUT: out },
			},
		);
		expect(r.status, r.stdout + r.stderr).toBe(0);
		return JSON.parse(
			fs.readFileSync(path.join(out, "env.json"), "utf8"),
		) as string[];
	};
	const readCoreBare = () =>
		execFileSync(
			"git",
			["-C", path.join(dir, "scratch"), "config", "core.bare"],
			{ encoding: "utf8" },
		).trim();

	it("marks the worktree's main repo bare without the setup file: the control", () => {
		runProbe({ GIT_DIR: gitDir }, false);
		expect(readCoreBare()).toBe("true");
	});

	it("leaves the worktree's main repo non-bare when a fixture runs a plain git init", () => {
		runProbe({ GIT_DIR: gitDir });
		expect(readCoreBare()).toBe("false");
	});

	it("hands the worker none of git's repository-locating variables", () => {
		const seen = runProbe({
			GIT_DIR: gitDir,
			GIT_WORK_TREE: path.join(dir, "wt"),
			GIT_INDEX_FILE: path.join(gitDir, "index"),
			GIT_COMMON_DIR: path.join(dir, "scratch", ".git"),
			GIT_OBJECT_DIRECTORY: path.join(dir, "scratch", ".git", "objects"),
			GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(
				dir,
				"scratch",
				".git",
				"objects",
			),
			GIT_PREFIX: "sub/",
		});
		expect(GIT_LOCATORS.filter((name) => seen.includes(name))).toEqual([]);
	});
});
