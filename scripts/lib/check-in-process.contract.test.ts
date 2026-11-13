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
import { afterEach, describe, expect, it } from "vitest";
import { checkInProcess } from "./check";

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

const spawned = (script: string, args: string[], repo: string) => {
	const r = spawnSync(process.execPath, [script, ...args], {
		cwd: repo,
		encoding: "utf8",
	});
	return { exit: r.status, stdout: r.stdout, stderr: r.stderr };
};

/* The fixture is the run's working directory, as the hook's is; chdir is the
 * test's, around the call, never the checker's. */
const inProcess = async (script: string, args: string[], repo: string) => {
	const { SPEC } = require(script);
	const was = process.cwd();
	process.chdir(repo);
	try {
		return await checkInProcess(SPEC, args, { script });
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
