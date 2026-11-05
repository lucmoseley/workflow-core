// @vitest-environment node
/*
 * Runs the worktree-model measurement (#4253) end to end over a real git
 * repository: a bare origin, a main checkout cloned from it, and one seat
 * holding a transcript. The readings themselves are pinned in
 * lib/worktree-model-reading.test.ts; this file crosses what that cannot —
 * the git reads, the transcript walk and the exit codes — once each, since a
 * reader that misreads git turns every check into a false PASS (§X11).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { projectSlug } from "./lib/project-slug.js";
import { runInProcessAsync } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "measure-worktree-model.js");

let tmp: string;
let main: string;
let seat: string;
let since: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const run = (...args: string[]) =>
	runInProcessAsync(SCRIPT, ["--since", since, ...args], {
		cwd: main,
		env: {
			...process.env,
			HOME: path.join(tmp, "home"),
			CLAUDE_PROJECT_DIR: main,
			WFC_CLAUDE_CONFIG_A: seat,
			WFC_CLAUDE_CONFIG_B: path.join(tmp, "seat-b"),
			WFC_CLAUDE_CONFIG_C: path.join(tmp, "seat-c"),
			WFC_REFILL_DIR: path.join(tmp, "refill"),
		},
	});

function writeTranscript(at: number) {
	const dir = path.join(seat, "projects", projectSlug(main));
	fs.mkdirSync(dir, { recursive: true });
	const records = [
		{
			type: "assistant",
			timestamp: new Date(at).toISOString(),
			message: {
				content: [
					{
						type: "tool_use",
						id: "t1",
						name: "Edit",
						input: { file_path: path.join(main, "a.txt") },
					},
				],
			},
		},
		{
			type: "user",
			timestamp: new Date(at + 1500).toISOString(),
			message: {
				content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
			},
		},
	];
	fs.writeFileSync(
		path.join(dir, "s1.jsonl"),
		`${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
	);
	/* The CLI reads only transcripts written since the window opened. */
	const when = new Date(at + 1500);
	fs.utimesSync(path.join(dir, "s1.jsonl"), when, when);
}

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtm-")));
	const origin = path.join(tmp, "origin.git");
	const seed = path.join(tmp, "seed");
	main = path.join(tmp, "main");
	seat = path.join(tmp, "seat-a");
	git(tmp, "init", "-q", "--bare", "-b", "main", origin);
	git(tmp, "init", "-q", "-b", "main", seed);
	fs.writeFileSync(path.join(seed, "a.txt"), "v1\n");
	git(seed, "add", "-A");
	git(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "v1");
	git(seed, "push", "-q", origin, "main", "main:landing");
	git(tmp, "clone", "-q", origin, main);
	git(main, "config", "user.email", "t@t");
	git(main, "config", "user.name", "t");
	/* After the clone's own writes, which no levelling pass made. */
	since = new Date(Date.now() + 1000).toISOString();
	writeTranscript(Date.parse(since) + 1000);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

it("passes a main checkout no session wrote, and times its Edit", async () => {
	const r = await run(
		"--until",
		new Date(Date.now() + 60_000).toISOString(),
		"--json",
	);

	expect(r.status, r.stderr).toBe(0);
	const out = JSON.parse(r.stdout);
	expect(out.failed).toBe(false);
	expect(out.costs.edit).toMatchObject({ n: 1, p50: 1500 });
});

it("fails on a commit made on main, and says so on stderr", async () => {
	await new Promise((resolve) => setTimeout(resolve, 2100));
	/* Crosses the real clock: reflog times are whole seconds, so the commit
	 * must fall after `since`. */
	fs.writeFileSync(path.join(main, "a.txt"), "v2\n");
	git(main, "commit", "-qam", "on main");

	const r = await run("--until", new Date(Date.now() + 60_000).toISOString());

	expect(r.status, r.stderr).toBe(1);
	expect(r.stderr).toMatch(/^FAIL commits on main not on origin\/main: 1 /m);
	expect(r.stdout).toBe("");
});

it("refuses a window that ends before it starts", async () => {
	const r = await run("--until", "2000-01-01T00:00:00Z");

	expect(r.status).toBe(2);
	expect(r.stderr).toContain("--since the earlier");
});
