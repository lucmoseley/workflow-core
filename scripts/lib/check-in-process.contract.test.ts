// @vitest-environment node
/*
 * The equivalence contract (#5172): a checker run in-process through
 * lib/check.js's checkInProcess() gives the same exit code, stdout and stderr
 * as the same checker spawned as `node <checker> <args>`, over the same
 * fixture tree. It is what licenses each pre-commit dispatcher row: a row
 * whose checker fails it keeps its own process.
 *
 * Each row is one checker and the trees it is judged on; each tree runs both
 * ways and the two are compared, never against a hand-written expectation.
 *
 * spawn-kept: the `spawned` helper is the real process every row is held to.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkInProcess } from "./check";
import { GATES } from "./precommit-gates.js";

const SCRIPTS = path.resolve(__dirname, "..");

interface Tree {
	name: string;
	build: (repo: string) => void;
}
interface Row {
	script: string;
	args: string[];
	trees: Tree[];
}

const git = (repo: string, ...args: string[]) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf8" });

const stage = (repo: string, file: string, body: string) => {
	fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
	fs.writeFileSync(path.join(repo, file), body);
	git(repo, "add", file);
};

const roadmapBase = (repo: string) => {
	stage(repo, "docs/reference-roadmap.html", "roadmap v1\n");
	stage(repo, "docs/roadmap-digest.md", "digest v1\n");
	git(repo, "commit", "-qm", "init");
};

/* A plugin root, so check-host-root.js judges rather than SKIPs (#83). */
const pluginBase = (repo: string) => {
	stage(repo, ".claude-plugin/plugin.json", '{ "name": "fixture" }\n');
	stage(repo, "scripts/ok.js", 'require("node:path");\n');
	git(repo, "commit", "-qm", "init");
};
const CLIMB = 'const ROOT = path.resolve(__dirname, "..");\n';
const HOST_ROOT_TREES: Tree[] = [
	{
		name: "a clean change staged",
		build: (repo) => {
			pluginBase(repo);
			stage(repo, "scripts/ok.js", 'require("node:path"); // two\n');
		},
	},
	{
		name: "a climb out of scripts/ staged",
		build: (repo) => {
			pluginBase(repo);
			stage(repo, "scripts/bad.js", CLIMB);
		},
	},
	{
		name: "a climb HEAD already carries",
		build: (repo) => {
			pluginBase(repo);
			stage(repo, "scripts/bad.js", CLIMB);
			git(repo, "commit", "-qm", "inherit");
			stage(repo, "scripts/ok.js", 'require("node:path"); // two\n');
		},
	},
];

const ROWS: Row[] = [
	{
		script: "check-host-root.js",
		args: ["--against", "HEAD"],
		trees: HOST_ROOT_TREES,
	},
	{ script: "check-host-root.js", args: ["--index"], trees: HOST_ROOT_TREES },
	{
		script: "check-roadmap-pair.js",
		args: [],
		trees: [
			{ name: "nothing staged", build: roadmapBase },
			{
				name: "the HTML staged alone",
				build: (repo) => {
					roadmapBase(repo);
					stage(repo, "docs/reference-roadmap.html", "roadmap v2\n");
				},
			},
			{
				name: "the digest staged alone",
				build: (repo) => {
					roadmapBase(repo);
					stage(repo, "docs/roadmap-digest.md", "digest v2\n");
				},
			},
		],
	},
];

const dirs: string[] = [];
const fixture = (tree: Tree) => {
	const repo = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "check-in-process-")),
	);
	dirs.push(repo);
	git(repo, "init", "-q", ".");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "test");
	tree.build(repo);
	return repo;
};
afterEach(() => {
	for (const d of dirs.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
});

/* The fixture is also the run's host (CLAUDE_PROJECT_DIR), as the hook's
 * repo is its own: vitest.setup.ts points the host at an empty non-repo. */
const spawned = (script: string, args: string[], repo: string) => {
	const r = spawnSync(process.execPath, [script, ...args], {
		cwd: repo,
		encoding: "utf8",
		env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
	});
	return { exit: r.status, stdout: r.stdout, stderr: r.stderr };
};

/* The fixture is the run's working directory, as the hook's is; chdir is the
 * test's, around the call, never the checker's. */
const inProcess = async (
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

describe.each(ROWS)("$script $args", ({ script, args, trees }) => {
	const file = path.join(SCRIPTS, script);
	it.each(trees)("runs in-process exactly as spawned: $name", async (tree) => {
		const repo = fixture(tree);
		expect(await inProcess(file, args, repo)).toEqual(
			spawned(file, args, repo),
		);
	});
});

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
			.replace(/^\s+at .*\n/gm, "");
	return { exit: r.exit, stdout: settle(r.stdout), stderr: settle(r.stderr) };
};

/* Every dispatcher row as the dispatcher runs it (#5172): its args, its sides
 * spawned where the row keeps a `side`, over a tree whose one commit holds the
 * row's arming path and whose index changes it. */
describe.each(GATES)("the $id dispatcher row", (row) => {
	it("runs in-process exactly as spawned over a change to its arming path", async () => {
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
				await inProcess(
					file,
					row.args,
					repo,
					row.side ? "spawn" : "in-process",
				),
			),
		).toEqual(settled(spawned(file, row.args, repo)));
	});
});
