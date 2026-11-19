// @vitest-environment node
/*
 * The weekly release cut's filer (#5435) over a throwaway core clone, with
 * `gh` and the issue-body writer stubbed. Break it and the cut ticket is filed
 * before a cut is allowed, with nothing to release, twice over, or never, or
 * a ticket a landed cut answered is left asking for a cut.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineTemplate, mkScratchDir } from "./lib/git-fixture";
import { fakeIssueBody } from "./lib/issue-body-testkit";
import { runInProcess } from "./lib/run-in-process";
import { shellQuote } from "./lib/sh-quote.js";

const SCRIPT = path.join(__dirname, "report-release-due.js");
const { CUT_TITLE } = require("./lib/release-due.js");
const DAY = 86_400;
const T0 = 1_790_000_000;
const iso = (s: number) => new Date(s * 1000).toISOString();

let dir: string;
let repo: string;

const git = (args: string[], at = 0): string => {
	const date = `@${T0 + at} +0000`;
	return execFileSync("git", args, {
		cwd: repo,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_DATE: date,
			GIT_COMMITTER_DATE: date,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
		},
	}).trim();
};

/** A core clone under `root`: v1.0.0 rendered from main's first commit and
 * tagged at T0, then `ahead` commits on origin/main. */
const buildCore =
	(ahead: number, name = "workflow-core") =>
	(root: string) => {
		repo = path.join(root, "repo");
		fs.mkdirSync(path.join(repo, ".claude-plugin"), { recursive: true });
		git(["init", "-q", "-b", "main"]);
		fs.writeFileSync(
			path.join(repo, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name }),
		);
		git(["add", "."]);
		git(["commit", "-q", "-m", "init"]);
		const source = git(["rev-parse", "HEAD"]);
		for (let i = 1; i <= ahead; i++)
			git(["commit", "-q", "--allow-empty", "-m", `c${i}`], i * 60);
		git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
		git(["checkout", "-q", "--orphan", "release"]);
		git([
			"commit",
			"-q",
			"-m",
			`Release workflow-core v1.0.0, rendered from ${source}`,
		]);
		git(["tag", "-a", "v1.0.0", "-m", "workflow-core v1.0.0"]);
		git(["checkout", "-q", "main"]);
	};

const fixture = defineTemplate({
	ahead: buildCore(3),
	level: buildCore(0),
	adopter: buildCore(3, "an-adopter"),
});

beforeEach(() => {
	dir = mkScratchDir("release-due-");
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function clone(variant: "ahead" | "level" | "adopter") {
	fixture.instantiate(dir, variant);
	repo = path.join(dir, "repo");
}

function stubs(issues: unknown[] = [], existingBody = "") {
	const issueBody = fakeIssueBody(dir, existingBody);
	const list = path.join(dir, "issues.json");
	fs.writeFileSync(list, JSON.stringify(issues));
	const argvLog = path.join(dir, "gh-argv.log");
	const ghStub = path.join(dir, "gh");
	fs.writeFileSync(
		ghStub,
		[
			"#!/bin/sh",
			`printf '%s\\n' "$*" >> ${shellQuote(argvLog)}`,
			'if [ "$1" = "issue" ] && [ "$2" = "list" ]; then',
			`  cat ${shellQuote(list)}`,
			'elif [ "$1" = "issue" ] && [ "$2" = "view" ]; then',
			`  cat ${shellQuote(issueBody.bodyFile)}`,
			'elif [ "$1" = "issue" ] && [ "$2" = "create" ]; then',
			"  echo https://github.com/o/r/issues/999",
			"fi",
			"exit 0",
		].join("\n"),
	);
	fs.chmodSync(ghStub, 0o755);
	const calls = () =>
		fs.existsSync(argvLog) ? fs.readFileSync(argvLog, "utf8") : "";
	const body = () => fs.readFileSync(issueBody.bodyFile, "utf8");
	return { ghStub, issueBody, calls, body };
}

function run(fx: ReturnType<typeof stubs>, atDays: number) {
	const r = runInProcess(SCRIPT, [], {
		cwd: repo,
		env: {
			...process.env,
			WFC_REPO_ROOT: repo,
			WFC_GH: fx.ghStub,
			WFC_ISSUE_BODY: fx.issueBody.script,
			WFC_NOW: iso(T0 + atDays * DAY),
		},
	});
	return { code: r.status, output: `${r.stdout}${r.stderr}` };
}

const openTicket = (createdDays: number) => ({
	number: 42,
	title: CUT_TITLE,
	labels: [],
	createdAt: iso(T0 + createdDays * DAY),
});

describe("the weekly release cut's filer", () => {
	it("files the cut ticket, labelled takes:implement, 7 days after the tag with commits to release", () => {
		clone("ahead");
		const fx = stubs();
		const { code, output } = run(fx, 7);
		expect(code).toBe(0);
		expect(output).toContain("3 commit(s) it does not carry");
		const calls = fx.calls();
		expect(calls).toContain("issue create");
		expect(calls).toContain(CUT_TITLE);
		expect(calls).toContain("--label takes:implement");
		expect(calls).toContain("release-plugin.js --push --file-bump-issues");
		expect(output).toContain("issues/999");
	});

	it("files nothing under 7 days after the tag", () => {
		clone("ahead");
		const fx = stubs();
		const { code, output } = run(fx, 6.9);
		expect(code).toBe(0);
		expect(output).toContain("under the 7-day cadence");
		expect(fx.calls()).not.toContain("issue create");
		expect(fx.issueBody.calls()).toEqual([]);
	});

	it("files nothing where origin/main holds nothing the tag does not carry", () => {
		clone("level");
		const fx = stubs();
		const { code, output } = run(fx, 30);
		expect(code).toBe(0);
		expect(output).toContain("holds no commit it does not carry");
		expect(fx.calls()).not.toContain("issue create");
	});

	it("refreshes the open cut ticket rather than filing a second", () => {
		clone("ahead");
		const fx = stubs([openTicket(7)], "old");
		const { code, output } = run(fx, 8);
		expect(code).toBe(0);
		expect(fx.calls()).not.toContain("issue create");
		expect(output).toContain("#42");
		expect(fx.issueBody.calls()).toEqual([
			expect.stringContaining("replace 42"),
		]);
	});

	it("leaves the open cut ticket's body alone while the tag and its due state hold", () => {
		clone("ahead");
		const fx = stubs([openTicket(7)], "old");
		run(fx, 8);
		fx.issueBody.clearCalls();
		git(["commit", "-q", "--allow-empty", "-m", "later"], 8 * DAY);
		git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
		const { output } = run(fx, 9);
		expect(output).toContain("#42 is open and current");
		expect(fx.issueBody.calls()).toEqual([]);
	});

	it("rewrites an open ticket filed before the last tag to say that cut landed", () => {
		clone("ahead");
		const fx = stubs([openTicket(-1)], "old");
		const { code } = run(fx, 2);
		expect(code).toBe(0);
		expect(fx.issueBody.calls()).toEqual([
			expect.stringContaining("replace 42"),
		]);
		expect(fx.body()).toContain("v1.0.0 was cut after this issue was filed");
	});

	it("leaves alone an open ticket filed after the last tag while no cut is due", () => {
		clone("ahead");
		const fx = stubs([openTicket(1)], "old");
		run(fx, 2);
		expect(fx.issueBody.calls()).toEqual([]);
	});

	it("skips by name outside workflow-core", () => {
		clone("adopter");
		const fx = stubs();
		const { code, output } = run(fx, 30);
		expect(code).toBe(0);
		expect(output).toContain("SKIP: not workflow-core itself");
		expect(fx.calls()).toBe("");
	});

	it("is BROKEN, naming the fetch, filing nothing, where the clone has no origin/main", () => {
		clone("ahead");
		git(["update-ref", "-d", "refs/remotes/origin/main"]);
		const fx = stubs();
		const { code, output } = run(fx, 30);
		expect(code).toBe(2);
		expect(output).toContain("BROKEN:");
		expect(output).toContain("origin/main");
		expect(fx.calls()).toBe("");
	});
});
