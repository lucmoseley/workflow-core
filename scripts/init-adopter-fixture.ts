import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, vi } from "vitest";
import { CI_WORKFLOW } from "./lib/adopter-ci.js";
import { skeletonPaths } from "./lib/core-owned-files.js";
import { defineTemplate, mkDirOutsideRepo } from "./lib/git-fixture";
import { adopt } from "./lib/init-adopter-core.js";
import { resolveConfigDir } from "./lib/plugin-state.js";
import { gateTmpdir } from "./lib/precommit-gate-harness.js";
import { runInProcess } from "./lib/run-in-process.js";
import { upgrade } from "./lib/upgrade-walk.js";

export const SKELETON_PATHS = skeletonPaths(
	(rel) => rel !== "package.json" && rel !== CI_WORKFLOW,
);

export const CORE = path.resolve(__dirname, "..");
export const SCRIPT = path.join(__dirname, "init-adopter.js");

export const made: string[] = [];
afterAll(() => {
	for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

// #2875
const emptyRepo = defineTemplate((dir) => {
	const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) };
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, env });
	git("init", "-q", "-b", "main", ".");
	git("config", "user.email", "fixture@example.invalid");
	git("config", "user.name", "Adopter Fixture");
});

export function repo() {
	return adopterFrom((dir) => emptyRepo.instantiate(dir));
}

function adopterFrom(fill: (dir: string) => void) {
	const dir = mkDirOutsideRepo("adopter-");
	made.push(dir);
	fill(dir);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, encoding: "utf8" });
	return { dir, git };
}

// #4296
const initedTrees = new Map<string, string>();
export function initialised(founder = "A Founder") {
	let tree = initedTrees.get(founder);
	if (tree === undefined) {
		tree = repo().dir;
		expect(init(tree, "--founder", founder, "--no-tracker").status).toBe(0);
		initedTrees.set(founder, tree);
	}
	const built = tree;
	return adopterFrom((dir) => fs.cpSync(built, dir, { recursive: true }));
}

function runNodeInProcess(
	root: string,
	script: string,
	args: string[],
	{ quiet = false }: { quiet?: boolean } = {},
) {
	const r = runInProcess(script, args, {
		cwd: root,
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: root,
			CLAUDE_CONFIG_DIR: resolveConfigDir(undefined),
		},
	});
	if (r.status === 0) return r.stdout;
	const stderr = quiet ? null : r.stderr;
	throw Object.assign(
		new Error(
			`Command failed: ${process.execPath} ${[script, ...args].join(" ")}${stderr ? `\n${stderr}` : ""}`,
		),
		{ status: r.status, stdout: r.stdout, stderr },
	);
}

export function adoptWith(
	args: string[],
	{ cwd, env = process.env }: { cwd: string; env?: NodeJS.ProcessEnv },
) {
	let stdout = "";
	let stderr = "";
	const savedEnv = process.env;
	const savedCwd = process.cwd();
	// env-write-kept: the case's env replaces the whole environment, as a spawn's does.
	process.env = { ...env };
	process.chdir(cwd);
	try {
		const status = adopt(args, {
			out: (text) => {
				stdout += text;
			},
			err: (text) => {
				stderr += text;
			},
			runNode: runNodeInProcess,
		});
		return { status, stdout, stderr };
	} finally {
		process.chdir(savedCwd);
		// env-write-kept: restores the object the call replaced above.
		process.env = savedEnv;
	}
}

const fixtureArgs = (dir: string, args: string[]) => [
	"--root",
	dir,
	"--plugin-root",
	CORE,
	// #75
	"--no-plugin-install",
	...args,
];

// #5
export const init = (dir: string, ...args: string[]) =>
	initIn(process.env, dir, ...args);

export const initIn = (
	env: NodeJS.ProcessEnv,
	dir: string,
	...args: string[]
) => adoptWith(fixtureArgs(dir, args), { cwd: dir, env });

export const initProgram = (dir: string, ...args: string[]) =>
	initProgramIn(process.env, dir, ...args);

export const initProgramIn = (
	env: NodeJS.ProcessEnv,
	dir: string,
	...args: string[]
) => runInProcess(SCRIPT, fixtureArgs(dir, args), { cwd: dir, env });

export function commitThroughHooks(
	dir: string,
	message: string,
	paths = SKELETON_PATHS,
	env = process.env,
) {
	execFileSync("git", ["add", "-N", ...paths], { cwd: dir });
	// #1839 #2648 #3296 lucmoseley/mantahostels#1452
	const config = fs.mkdtempSync(path.join(os.tmpdir(), "adopter-config-"));
	made.push(config);
	const { WFC_MODULES: _suite, ...own } = env;
	return spawnSync("git", ["commit", "-m", message, "--", ...paths], {
		cwd: dir,
		encoding: "utf8",
		env: {
			WORKFLOW_CORE_DIR: CORE,
			...own,
			CLAUDE_PROJECT_DIR: dir,
			CLAUDE_CONFIG_DIR: config,
			TMPDIR: gateTmpdir(dir),
		},
	});
}

export function upgradeAfterInit(
	dir: string,
	labels?: Parameters<typeof upgrade>[0]["labels"],
) {
	const lines: string[] = [];
	vi.stubEnv("WFC_MODULES", undefined);
	try {
		upgrade({ root: dir, pluginRoot: CORE, out: (l) => lines.push(l), labels });
	} finally {
		vi.unstubAllEnvs();
	}
	return lines;
}
