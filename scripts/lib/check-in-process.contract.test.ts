// @vitest-environment node
/*
 * The equivalence contract (#5172), per checker: a checker run in-process
 * through lib/check.js's checkInProcess() gives the same exit code, stdout and
 * stderr as the same checker spawned as `node <checker> <args>`, over the same
 * fixture tree. It is what licenses each pre-commit dispatcher row: a row
 * whose checker fails it keeps its own process. The per-dispatcher-row cases
 * are check-in-process-armed-rows, -always-rows and -side-rows (#5191).
 *
 * Each row is one checker and the trees it is judged on; each tree runs both
 * ways and the two are compared, never against a hand-written expectation.
 * Breaking it costs that licence: a checker whose in-process run drifts from
 * its process would refuse, or pass, a commit differently from its own CLI,
 * and nothing else compares the two.
 */

import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	fixture,
	git,
	inProcess,
	removeFixtures,
	SCRIPTS,
	spawned,
	stage,
	type Tree,
} from "./check-in-process-testkit";

interface Row {
	script: string;
	args: string[];
	trees: Tree[];
}

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

afterEach(removeFixtures);

describe.each(ROWS)("$script $args", ({ script, args, trees }) => {
	const file = path.join(SCRIPTS, script);
	it.each(trees)("runs in-process exactly as spawned: $name", async (tree) => {
		const repo = fixture(tree);
		expect(await inProcess(file, args, repo)).toEqual(
			spawned(file, args, repo),
		);
	});
});
