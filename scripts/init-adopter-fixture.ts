import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, vi } from "vitest";
import { skeletonPaths } from "./lib/core-owned-files.js";
import { defineTemplate, mkDirOutsideRepo } from "./lib/git-fixture";
import { gateTmpdir } from "./lib/precommit-gate-harness.js";
import { runInProcess } from "./lib/run-in-process.js";
import { upgrade } from "./lib/upgrade-walk.js";

/* These fixtures hold no package.json, and a pathspec naming it fails. */
export const SKELETON_PATHS = skeletonPaths((rel) => rel !== "package.json");

export const CORE = path.resolve(__dirname, "..");
export const SCRIPT = path.join(__dirname, "init-adopter.js");

export const made: string[] = [];
afterAll(() => {
	for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

/* The template builds under git-fixture's scratch base, inside this checkout,
 * so the ceiling stops a failed `git init` from letting `git config` write
 * into the checkout's own .git/config (#2875). */
const emptyRepo = defineTemplate((dir) => {
	const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) };
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, env });
	git("init", "-q", "-b", "main", ".");
	/* An identity, so the tests' commits are not refused for want of one. */
	git("config", "user.email", "fixture@example.invalid");
	git("config", "user.name", "Adopter Fixture");
});

/* Copies land outside any repository, not under the scratch base, so no
 * test's adopter repo sits inside this checkout. Residual: they are back on
 * the shared /tmp, where mantahostels#3144 saw a fixture deleted mid-copy. */
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

/* A plain init's tree, run once per founder and copied per case (#4296): for
 * a case that judges what follows that run, never the run's own output. A
 * copy is byte-identical, modes included, as init writes no absolute path of
 * its root into the tree. Built on first use, not in beforeAll: two founders,
 * each wanted by only some cases. */
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

export const init = (dir: string, ...args: string[]) =>
	initIn(process.env, dir, ...args);

export const initIn = (
	env: NodeJS.ProcessEnv,
	dir: string,
	...args: string[]
) =>
	runInProcess(
		SCRIPT,
		[
			"--root",
			dir,
			"--plugin-root",
			CORE,
			/* Every fixture skips it: a real `claude plugin install` mutates this
			 * machine's own plugin registry and is exercised on its own, against a
			 * stub `claude`, in init-adopter.test.ts (#75). */
			"--no-plugin-install",
			...args,
		],
		{
			cwd: dir,
			/* init() passes NO CLAUDE_PROJECT_DIR: init sets it for its own
			 * children, so supplying it would prove the harness rather than the
			 * script (#5). */
			env,
		},
	);

/** A pathspec commit of `paths` in the adopter, through its own hooks. */
export function commitThroughHooks(
	dir: string,
	message: string,
	paths = SKELETON_PATHS,
	env = process.env,
) {
	/* Intent-to-add, so the pathspec commit the convention asks for can name
	 * files git has never seen. */
	execFileSync("git", ["add", "-N", ...paths], { cwd: dir });
	/* The shims run this checkout, as CI's WORKFLOW_CORE_CHECKOUT would: the
	 * fixture has no install row for them to resolve (#1839). The skeleton's
	 * hooks arm the real shellcheck gate, so the commit takes the fixture's own
	 * TMPDIR for its lock, set after `env` so no caller's replaces it (#2648).
	 * CLAUDE_PROJECT_DIR is the adopter's, as its own session's would be: a
	 * session's inherited value names this checkout, and the hooks would read
	 * its config and run its `npm run check:staged` in the adopter (#3296).
	 * CLAUDE_CONFIG_DIR is the commit's own, so a guard failing open under the
	 * hooks logs there, never in the developer's live log (mantahostels#1452). */
	const config = fs.mkdtempSync(path.join(os.tmpdir(), "adopter-config-"));
	made.push(config);
	return spawnSync("git", ["commit", "-m", message, "--", ...paths], {
		cwd: dir,
		encoding: "utf8",
		env: {
			WORKFLOW_CORE_DIR: CORE,
			...env,
			CLAUDE_PROJECT_DIR: dir,
			CLAUDE_CONFIG_DIR: config,
			TMPDIR: gateTmpdir(dir),
		},
	});
}

/**
 * The suite injects WFC_MODULES, which replaces the declared list; the
 * spawned init never saw it, so the upgrade must not either.
 */
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
