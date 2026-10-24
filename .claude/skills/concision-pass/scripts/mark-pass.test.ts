// @vitest-environment node
/*
 * mark-pass.test.ts — the concision-pass marker writer: its refusals and the
 * marker's shape, which the Stop backstop reads.
 *
 * Black-box, in a throwaway git repo (§X3): the base comes from real git.
 * Break the writer and every session that ran a pass is still nagged at Stop.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkScratchDir } from "../../../../scripts/lib/git-fixture";
import { runInProcess } from "../../../../scripts/lib/run-in-process.js";

const MARK = path.resolve(__dirname, "mark-pass.js");
const SID = "session-under-test";

let repo: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const markers = () => path.join(repo, ".claude", "tmp", "markers");
const marker = () => path.join(markers(), `.concision-pass-${SID}`);

const run = (...args: string[]) => runAt(repo, ...args);
const runAt = (cwd: string, ...args: string[]) => {
	const env: Record<string, string | undefined> = {
		...process.env,
		CLAUDE_CODE_SESSION_ID: SID,
	};
	delete env.CLAUDE_PROJECT_DIR;
	return runInProcess(MARK, args, { cwd, env });
};

beforeEach(() => {
	repo = mkScratchDir("mark-pass-");
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	git("commit", "-q", "--allow-empty", "-m", "seed");
	fs.mkdirSync(markers(), { recursive: true });
});

afterEach(() => {
	fs.rmSync(repo, { recursive: true, force: true });
});

describe("mark-pass.js", () => {
	it("writes the session base, the count and the route", () => {
		const head = git("rev-parse", "HEAD");
		fs.writeFileSync(path.join(markers(), `.concision-base-${SID}`), head);
		expect(run("3").status).toBe(0);
		expect(fs.readFileSync(marker(), "utf8")).toBe(
			`base=${head}\nfindings=3\nroute=in-session\n`,
		);
	});

	it("writes into the shared tree's markers from a linked worktree, where the backstop reads", () => {
		const head = git("rev-parse", "HEAD");
		fs.writeFileSync(path.join(markers(), `.concision-base-${SID}`), head);
		const outer = mkScratchDir("mark-pass-wt-");
		const wt = path.join(outer, "wt");
		git("worktree", "add", "-q", "--detach", wt);
		try {
			expect(runAt(wt, "0").status).toBe(0);
			expect(fs.readFileSync(marker(), "utf8")).toContain(`base=${head}\n`);
		} finally {
			git("worktree", "remove", "--force", wt);
			fs.rmSync(outer, { recursive: true, force: true });
		}
	});

	it("prefers the recorded start point to --base", () => {
		const start = git("rev-parse", "HEAD");
		fs.writeFileSync(path.join(markers(), `.concision-base-${SID}`), start);
		git("commit", "-q", "--allow-empty", "-m", "later");
		run("0", "--base", "HEAD");
		expect(fs.readFileSync(marker(), "utf8")).toContain(`base=${start}\n`);
	});

	it.each([
		["a count that is not digits", ["two", "--base", "HEAD"], "digits only"],
		["no start point and no --base", ["0"], "pass --base"],
		["a --base git cannot resolve", ["0", "--base", "nope"], "not a commit"],
		["a second count", ["0", "1", "--base", "HEAD"], "usage:"],
	])("refuses %s, writing nothing", (_, args, fault) => {
		const r = run(...args);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(fault);
		expect(fs.existsSync(marker())).toBe(false);
	});
});
