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
 * Also pins its removal of git's repository-locating variables (#1677), and its
 * empty host (#3334), without which a test that drops its CLAUDE_PROJECT_DIR
 * pin reads the live checkout and is red only on the founder's machine.
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

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * Runs `<dir>/probe.test.ts` in a nested vitest under `env`, loading the real
 * setup file unless `withSetup` is false. Returns the JSON the probe wrote to
 * `<PROBE_OUT>/<outFile>`.
 */
const runNestedVitest = <T>(
	dir: string,
	env: NodeJS.ProcessEnv,
	outFile: string,
	withSetup = true,
): T => {
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
				setupFiles: withSetup ? [path.join(REPO_ROOT, "vitest.setup.ts")] : [],
			},
		})};\n`,
	);
	const r = spawnSync(
		process.execPath,
		[
			path.join(REPO_ROOT, "node_modules/vitest/vitest.mjs"),
			"run",
			"--config",
			config,
		],
		{ cwd: dir, encoding: "utf8", env: { ...env, PROBE_OUT: out } },
	);
	expect(r.status, r.stdout + r.stderr).toBe(0);
	return JSON.parse(fs.readFileSync(path.join(out, outFile), "utf8")) as T;
};

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
	const runProbe = (leaked: Record<string, string>, withSetup = true) =>
		runNestedVitest<string[]>(
			dir,
			{ ...process.env, ...leaked },
			"env.json",
			withSetup,
		);
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

/*
 * #3334: a test that drops its `CLAUDE_PROJECT_DIR` pin, or reaches the host in
 * process, reads the same empty non-repository whether the run started under a
 * session's live checkout or, as in CI, with the variable unset, and so does a
 * child spawned on the inherited env. The probe asks from inside this
 * checkout, so without the setup file's override the git limb answers it.
 */
describe("the host a test that drops its pin reads (#3334)", () => {
	const hostRootModule = path.join(REPO_ROOT, "scripts/lib/host-root.js");
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-host-env-"));
		fs.writeFileSync(
			path.join(dir, "probe.test.ts"),
			`import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { hostRoot, worktreeRoot } from ${JSON.stringify(hostRootModule)};
test("probe", () => {
	const from = ${JSON.stringify(REPO_ROOT)};
	const host = hostRoot(from);
	const spawned = execFileSync(
		process.execPath,
		["-e", ${JSON.stringify(`process.stdout.write(require(${JSON.stringify(hostRootModule)}).hostRoot())`)}],
		{ cwd: from, encoding: "utf8" },
	);
	fs.writeFileSync(
		path.join(process.env.PROBE_OUT as string, "host.json"),
		JSON.stringify({
			host,
			worktree: worktreeRoot(from),
			spawned,
			entries: fs.readdirSync(host),
		}),
	);
});
`,
		);
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	const readHost = (projectDir: string | undefined, withSetup = true) => {
		const env: NodeJS.ProcessEnv = { ...process.env };
		if (projectDir === undefined) delete env.CLAUDE_PROJECT_DIR;
		else env.CLAUDE_PROJECT_DIR = projectDir;
		return runNestedVitest<{
			host: string;
			worktree: string;
			spawned: string;
			entries: string[];
		}>(dir, env, "host.json", withSetup);
	};

	it("reads this checkout with the variable unset and no setup file: the control", () => {
		expect(readHost(undefined, false).host).toBe(fs.realpathSync(REPO_ROOT));
	});

	it.each([
		["set to a session's live checkout", REPO_ROOT],
		["unset, as in CI", undefined],
	])("is an empty temp dir when the run starts with it %s", (_, projectDir) => {
		const seen = readHost(projectDir);
		expect(seen.host.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)).toBe(
			true,
		);
		expect(seen.entries).toEqual([]);
		expect(seen.worktree).toBe(seen.host);
		expect(seen.spawned).toBe(seen.host);
	});
});
