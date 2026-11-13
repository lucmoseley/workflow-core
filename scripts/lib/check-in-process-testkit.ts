/*
 * The machinery the check-in-process equivalence contract (#5172) shares
 * across its files (#5191): a checker run in-process through lib/check.js's
 * checkInProcess() gives the same exit code, stdout and stderr as the same
 * checker spawned as `node <checker> <args>`, over the same fixture tree.
 * The cases are split across files only so they run on separate workers.
 *
 * FOR TESTS ONLY.
 *
 * spawn-kept: the `spawned` helper is the real process every row is held to.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, vi } from "vitest";
import { checkInProcess } from "./check";
import { defineTemplate } from "./git-fixture";
import type { GATES } from "./precommit-gates.js";

export const SCRIPTS = path.resolve(__dirname, "..");

export interface Tree {
	name: string;
	build: (repo: string) => void;
}

export const git = (repo: string, ...args: string[]) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf8" });

export const stage = (repo: string, file: string, body: string) => {
	fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
	fs.writeFileSync(path.join(repo, file), body);
	git(repo, "add", file);
};

/** An empty repo with its identity set, built once per file and copied per tree. */
const EMPTY = defineTemplate((dir) => {
	git(dir, "init", "-q", ".");
	git(dir, "config", "user.email", "test@example.com");
	git(dir, "config", "user.name", "test");
});

const dirs: string[] = [];
export const fixture = (tree: Tree) => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), "check-in-process-"));
	dirs.push(parent);
	const repo = fs.realpathSync(EMPTY.instantiate(path.join(parent, "repo")));
	tree.build(repo);
	return repo;
};
/** Each file's `afterEach`: removes the trees its cases built. */
export const removeFixtures = () => {
	for (const d of dirs.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
};

/* The fixture is also the run's host (CLAUDE_PROJECT_DIR), as the hook's
 * repo is its own: vitest.setup.ts points the host at an empty non-repo. */
export const spawned = (script: string, args: string[], repo: string) => {
	const r = spawnSync(process.execPath, [script, ...args], {
		cwd: repo,
		encoding: "utf8",
		env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
	});
	return { exit: r.status, stdout: r.stdout, stderr: r.stderr };
};

/* The fixture is the run's working directory, as the hook's is; chdir is the
 * test's, around the call, never the checker's. */
export const inProcess = async (
	script: string,
	args: string[],
	repo: string,
	sides: "spawn" | "in-process" = "in-process",
) => {
	const { SPEC } = require(script);
	const was = process.cwd();
	process.chdir(repo);
	vi.stubEnv("CLAUDE_PROJECT_DIR", repo);
	try {
		return await checkInProcess(SPEC, args, { script, sides });
	} finally {
		process.chdir(was);
	}
};

/* A run with what differs between any two runs taken out: the random name of
 * each materialised tree, and a BROKEN's stack frames. */
const settled = (r: {
	exit: number | null;
	stdout: string;
	stderr: string;
}) => {
	const settle = (t: string) =>
		t
			.replace(/check-against-[\w-]+?-\w{6}\/tree-\w{6}/g, "<tree>")
			.replace(/^[ \t]+at .*\n/gm, "");
	return { exit: r.exit, stdout: settle(r.stdout), stderr: settle(r.stderr) };
};

/* Every dispatcher row as the dispatcher runs it (#5172): its args, its sides
 * spawned where the row keeps a `side`, over a tree whose one commit holds the
 * row's arming path and whose index changes it. */
export const dispatcherRowCase = async (row: (typeof GATES)[number]) => {
	/* An always-armed row has no arming path: any change arms it. */
	const at = "staged" in row ? row.staged : "notes.txt";
	const repo = fixture({
		name: at,
		build: (r) => {
			const json = at.endsWith(".json");
			stage(r, at, json ? '{ "v": 1 }\n' : "one\n");
			git(r, "commit", "-qm", "init");
			stage(r, at, json ? '{ "v": 2 }\n' : "two\n");
		},
	});
	const file = path.join(SCRIPTS, path.relative("scripts", row.script));
	/* A program row: its PROGRAM against its own process shell, in the
	 * fixture as the dispatcher runs it in the hook's repo. */
	if (row.kind === "program") {
		const { PROGRAM } = require(file);
		const was = process.cwd();
		process.chdir(repo);
		vi.stubEnv("CLAUDE_PROJECT_DIR", repo);
		try {
			expect(PROGRAM({ cwd: repo, env: process.env })).toEqual(
				spawned(file, row.args, repo),
			);
		} finally {
			process.chdir(was);
		}
		return;
	}
	expect(
		settled(
			await inProcess(file, row.args, repo, row.side ? "spawn" : "in-process"),
		),
	).toEqual(settled(spawned(file, row.args, repo)));
};
