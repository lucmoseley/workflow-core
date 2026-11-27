// @vitest-environment node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildAgentsBranch, buildListedRow } from "./lib/agents-stop-fake";
import {
	commitAll,
	freshSandbox,
	gitRepo,
	proc,
	putLock,
} from "./lib/arbiter-testkit";
import { writeClaudeStub } from "./lib/claude-stub";
import { readText } from "./lib/file-read.js";
import { stubGhScript } from "./lib/gh-stub";
import { markerName } from "./lib/orphan-filings.js";
import { runInProcessAsync } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "remove-orphaned-worktree.js");

const sb = freshSandbox((fresh) => {
	fs.mkdirSync(path.join(fresh.dir, "bin"), { recursive: true });
	fs.writeFileSync(path.join(fresh.repo, "a.txt"), "seed\n");
	fs.writeFileSync(path.join(fresh.repo, "c.txt"), "seed\n");
	fs.writeFileSync(path.join(fresh.repo, ".gitignore"), "*.log\n");
	gitRepo(fresh);
	commitAll(fresh);
	fakeClaude("bystander");
	fakeGh();
});

function fakeClaude(...sessionIds: string[]) {
	const bin = writeClaudeStub(path.join(sb.dir, "bin", "claude"), [
		buildAgentsBranch(
			sessionIds.map((sessionId, i) =>
				buildListedRow({ pid: 100 + i, sessionId }),
			),
		),
	]);
	vi.stubEnv("WFC_CLAUDE_BIN", bin);
}

const ghLog = () => path.join(sb.dir, "gh-calls");

function fakeGh() {
	const { env } = stubGhScript(
		sb.dir,
		`#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(ghLog())}\ncase "$*" in *view*) echo CLOSED;; esac\n`,
	);
	vi.stubEnv("WFC_GH", env.WFC_GH);
}

function ghCalls() {
	const read = readText(ghLog());
	if (read.state === "absent") return [];
	if (read.state === "unreadable") throw read.error;
	return read.data.split("\n").filter(Boolean);
}

const git = (cwd: string, ...args: string[]) =>
	spawnSync("git", args, { cwd, encoding: "utf8" });

function landOnOrigin(...commits: Record<string, string>[]) {
	const head = git(sb.repo, "rev-parse", "HEAD").stdout.trim();
	for (const files of commits) {
		for (const [rel, content] of Object.entries(files))
			fs.writeFileSync(path.join(sb.repo, rel), content);
		commitAll(sb, "landed");
	}
	git(sb.repo, "update-ref", "refs/remotes/origin/main", "HEAD");
	git(sb.repo, "reset", "-q", "--hard", head);
}

function worktree(name = "w1") {
	const wt = path.join(sb.repo, ".claude", "worktrees", name);
	fs.mkdirSync(path.dirname(wt), { recursive: true });
	const r = git(sb.repo, "worktree", "add", "-q", "--detach", wt);
	if (r.status !== 0) throw new Error(r.stderr);
	return fs.realpathSync(wt);
}

function ownJob(sessionId: string, wt: string) {
	const job = path.join(sb.home, "jobs", sessionId.slice(0, 8));
	fs.mkdirSync(job, { recursive: true });
	fs.writeFileSync(
		path.join(job, "state.json"),
		JSON.stringify({
			sessionId,
			name: "Worker one",
			cwd: wt,
			updatedAt: new Date().toISOString(),
		}),
	);
}

function fileFor(wt: string, ref: string, state = "s") {
	const dir = path.join(sb.repo, ".git", "orphaned-edits-filed");
	fs.mkdirSync(dir, { recursive: true });
	const marker = path.join(
		dir,
		markerName({ worktree: ".claude/worktrees/w1", state }),
	);
	fs.writeFileSync(
		marker,
		JSON.stringify({ worktree: ".claude/worktrees/w1", dirt: [], ref, at: 1 }),
	);
	expect(fs.existsSync(path.join(wt, ".git"))).toBe(true);
	return marker;
}

const remove = async (target: string, cwd = sb.repo) => {
	const r = await runInProcessAsync(SCRIPT, [target], {
		cwd,
		env: {
			...process.env,
			GITHUB_ACTIONS: "",
			CLAUDE_PROJECT_DIR: sb.repo,
			CLAUDE_CODE_SESSION_ID: "",
		},
	});
	return { status: r.status, out: r.stdout + r.stderr };
};

const registered = (wt: string) =>
	git(sb.repo, "worktree", "list", "--porcelain").stdout.includes(
		`worktree ${wt}\n`,
	);

const expectRefused = (
	r: { status: number | null; out: string },
	why: string,
) => {
	expect(r.out).toContain("refused, nothing removed");
	expect(r.out).toContain(why);
	expect(r.out).toContain("session-checkout.js land");
	expect(r.status).toBe(1);
};

describe("remove-orphaned-worktree", () => {
	it("removes a worktree whose every change has landed, and closes its filing", async () => {
		landOnOrigin({ "a.txt": "worktree edit\n" });
		const wt = worktree();
		fs.writeFileSync(path.join(wt, "a.txt"), "worktree edit\n");
		fs.writeFileSync(path.join(wt, "debug.log"), "ignored\n");
		const marker = fileFor(wt, "https://github.com/o/r/issues/7");

		const r = await remove(wt);

		expect(r.out).toContain(`${wt}: removed.`);
		expect(r.status).toBe(0);
		expect(fs.existsSync(wt)).toBe(false);
		expect(registered(wt)).toBe(false);
		expect(fs.existsSync(marker)).toBe(false);
		const [close, view] = ghCalls();
		expect(close).toContain("issue close 7 --repo o/r --reason completed");
		expect(view).toContain("issue view 7 --repo o/r");
		expect(r.out).toContain(
			"https://github.com/o/r/issues/7: closed as completed",
		);
	});

	it("closes every filing its worktree carries, a superseded one included", async () => {
		landOnOrigin();
		const wt = worktree();
		fileFor(wt, "https://github.com/o/r/issues/7", "old");
		fileFor(wt, "https://github.com/o/r/issues/9", "new");

		const r = await remove(wt);

		expect(r.status).toBe(0);
		const closed = ghCalls().filter((c) => c.startsWith("issue close"));
		expect(closed.map((c) => c.split(" ")[2]).sort()).toEqual(["7", "9"]);
	});

	it("judges a change against the landed ref's history, not its tip (#560)", async () => {
		landOnOrigin({ "a.txt": "worktree edit\n" }, { "a.txt": "moved on\n" });
		const wt = worktree();
		fs.writeFileSync(path.join(wt, "a.txt"), "worktree edit\n");

		const r = await remove(wt);

		expect(r.status).toBe(0);
		expect(fs.existsSync(wt)).toBe(false);
		expect(r.out).toContain("no issue was closed");
	});

	it("refuses a path that is not a registered worktree", async () => {
		landOnOrigin();
		const stray = path.join(sb.dir, "stray");
		fs.mkdirSync(stray);

		expectRefused(await remove(stray), "is not a registered worktree");
		expect(fs.existsSync(stray)).toBe(true);
	});

	it("refuses the worktree its caller stands in", async () => {
		landOnOrigin();
		const wt = worktree();

		expectRefused(
			await remove(wt, wt),
			"holds this command's own working directory",
		);
		expect(registered(wt)).toBe(true);
	});

	it("refuses a worktree whose HEAD has a commit off origin/main", async () => {
		landOnOrigin();
		const wt = worktree();
		fs.writeFileSync(path.join(wt, "c.txt"), "committed here\n");
		git(wt, "commit", "-qam", "local");

		expectRefused(
			await remove(wt),
			"its HEAD has 1 commit(s) not on origin/main",
		);
		expect(registered(wt)).toBe(true);
	});

	it("refuses where origin/main does not resolve", async () => {
		const wt = worktree();
		expectRefused(await remove(wt), "origin/main does not resolve");
	});

	it("refuses a change not on origin/main's history", async () => {
		landOnOrigin({ "c.txt": "other\n" });
		const wt = worktree();
		fs.writeFileSync(path.join(wt, "a.txt"), "never landed\n");

		expectRefused(
			await remove(wt),
			"changed and not on origin/main's history: a.txt",
		);
		expect(fs.readFileSync(path.join(wt, "a.txt"), "utf8")).toBe(
			"never landed\n",
		);
	});

	it("refuses a deletion origin/main still carries", async () => {
		landOnOrigin();
		const wt = worktree();
		fs.rmSync(path.join(wt, "a.txt"));

		expectRefused(
			await remove(wt),
			"deleted here but still on origin/main: a.txt",
		);
	});

	it("refuses untracked files in a node_modules that is no dependency link", async () => {
		landOnOrigin();
		const wt = worktree();
		fs.mkdirSync(path.join(wt, "node_modules"));
		fs.writeFileSync(path.join(wt, "node_modules", "x.js"), "local\n");

		expectRefused(await remove(wt), "node_modules/x.js");
	});

	it("passes over a node_modules dependency link and removes only the link", async () => {
		landOnOrigin();
		const wt = worktree();
		const store = path.join(sb.dir, "store");
		fs.mkdirSync(store);
		fs.writeFileSync(path.join(store, "dep.js"), "shared\n");
		fs.symlinkSync(store, path.join(wt, "node_modules"));

		expect((await remove(wt)).status).toBe(0);
		expect(fs.existsSync(path.join(store, "dep.js"))).toBe(true);
	});

	it("refuses while a live process has its working directory inside it", async () => {
		landOnOrigin();
		const wt = worktree();
		fs.mkdirSync(path.join(wt, "sub"));
		const child = spawn("sleep", ["30"], { cwd: path.join(wt, "sub") });
		try {
			await new Promise((r) => child.once("spawn", r));
			expectRefused(
				await remove(wt),
				`process(es) ${String(child.pid)} have their working directory inside it`,
			);
		} finally {
			child.kill("SIGKILL");
		}
		expect(registered(wt)).toBe(true);
	});

	it("refuses while a live session owns it", async () => {
		landOnOrigin();
		const wt = worktree();
		ownJob("live-owner-1", wt);
		fakeClaude("bystander", "live-owner-1");

		expectRefused(
			await remove(wt),
			"live session live-owner-1 (Worker one) owns it",
		);
		expect(registered(wt)).toBe(true);
	});

	it("refuses while a live session's claim names a path in it", async () => {
		landOnOrigin();
		const wt = worktree();
		putLock("a.txt", {
			sessionId: "holder",
			pid: process.pid,
			procStart: proc.readProcStartOf(process.pid),
			tree: wt,
		});

		expectRefused(
			await remove(wt),
			"a live session claims, observed or wrote 1 path(s) in it",
		);
	});

	it("removes a worktree whose owning session is no longer listed", async () => {
		landOnOrigin();
		const wt = worktree();
		ownJob("dead-owner-1", wt);

		expect((await remove(wt)).status).toBe(0);
		expect(registered(wt)).toBe(false);
	});
});
