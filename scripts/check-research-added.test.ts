// @vitest-environment node
/*
 * check-research-added.js refuses a commit adding a file under docs/research/
 * and prints the rule (#2356). Each case stages in a throwaway repo with no
 * hooks and runs the checker in process against that index. The checker is
 * the rule's only enforcement, in .husky/pre-commit, so a case loosened here
 * lets a research snapshot land in the tree with nothing refusing it.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initGitRepo, mkScratchDir } from "./lib/git-fixture";
import { armingPattern } from "./lib/precommit-gate-harness";
import { runInProcess } from "./lib/run-in-process";

const CHECKER = "scripts/check-research-added.js";
const SCRIPT = path.join(__dirname, "check-research-added.js");
const RULE = fs
	.readFileSync(
		path.join(
			__dirname,
			"..",
			"docs",
			"agents",
			"rules",
			"research-in-tree.txt",
		),
		"utf8",
	)
	.trimEnd();

let dir: string;
let hooks: string;

const git = (...args: string[]) =>
	spawnSync("git", args, { cwd: dir, encoding: "utf8" });

const write = (file: string, body = "x\n") => {
	fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
	fs.writeFileSync(path.join(dir, file), body);
};

const check = () => {
	const r = runInProcess(SCRIPT, [], { cwd: dir });
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

const expectRefused = (file: string) => {
	const r = check();
	expect(r.status).toBe(1);
	expect(r.out).toContain(file);
	expect(r.out).toContain("docs/agents/issue-tracker.md §Research artefacts");
	expect(r.out).toContain(RULE);
};

const commitAll = () => {
	git("add", "-A");
	expect(git("commit", "-qm", "seed").status).toBe(0);
};

beforeEach(() => {
	dir = mkScratchDir("research-added-");
	hooks = mkScratchDir("research-added-hooks-");
	initGitRepo(dir, hooks);
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(hooks, { recursive: true, force: true });
});

describe("check-research-added", () => {
	it("refuses an index adding docs/research/x.md, naming it and printing the whole rule", () => {
		write("docs/research/x.md");
		git("add", "--", "docs/research/x.md");
		expectRefused("docs/research/x.md");
	});

	it("refuses a rename into docs/research/", () => {
		write("notes/x.md");
		commitAll();
		fs.mkdirSync(path.join(dir, "docs/research"), { recursive: true });
		expect(git("mv", "notes/x.md", "docs/research/x.md").status).toBe(0);
		expectRefused("docs/research/x.md");
	});

	it("passes an edit to a kept note, printing no rule", () => {
		write("docs/research/kept.md");
		commitAll();
		write("docs/research/kept.md", "edited\n");
		git("add", "--", "docs/research/kept.md");
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).not.toContain(RULE);
	});

	it("passes the deletion of a kept note", () => {
		write("docs/research/kept.md");
		commitAll();
		git("rm", "-q", "--", "docs/research/kept.md");
		expect(check().status).toBe(0);
	});

	it("passes a file added outside docs/research/", () => {
		write("docs/other/x.md");
		git("add", "--", "docs/other/x.md");
		expect(check().status).toBe(0);
	});

	it("is armed in .husky/pre-commit on the directory it reads", () => {
		expect(new RegExp(armingPattern(CHECKER)).test("docs/research/x.md")).toBe(
			true,
		);
	});
});
