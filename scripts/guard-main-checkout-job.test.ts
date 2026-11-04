// @vitest-environment node
/*
 * scripts/guard-main-checkout-job.js against real git (#4340): a bare origin
 * carrying `main` and `landing`, a main checkout cloned from it, a job
 * directory holding the harness's record, and a fake `claude` that records
 * each call. `npm` is a stub, as in session-checkout.test.ts.
 *
 * Loosen it and an agents-view job edits in the main checkout, a job already
 * in its worktree or a resumed one is relaunched, the copy runs on another
 * plan or under the original's job identity, or a failed relaunch leaves the
 * session unaware of the worktree cut for it.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";

const SCRIPT = path.resolve(__dirname, "guard-main-checkout-job.js");

let tmp: string;
let main: string;
let seat: string;
let jobDir: string;
let calls: string;
let fakeClaude: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const RECORD = {
	intent: "/implement 4340",
	name: "implement-4340",
	respawnFlags: ["--agent", "claude", "--model", "claude-opus-5-5[1m]"],
	daemonShort: "0b42764c",
	sessionId: "0b42764c-6d71-45ce-b78a-d6773460aead",
};

const writeRecord = (record: object) => {
	fs.mkdirSync(jobDir, { recursive: true });
	fs.writeFileSync(path.join(jobDir, "state.json"), JSON.stringify(record));
};

const run = (
	payload: object,
	env: Record<string, string | undefined> = {},
	cwd = main,
) =>
	runInProcess(SCRIPT, [], {
		cwd,
		stdin: JSON.stringify(payload),
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: main,
			CLAUDE_JOB_DIR: jobDir,
			CLAUDE_CODE_SESSION_ID: RECORD.sessionId,
			CLAUDE_CONFIG_DIR: path.join(tmp, "some-other-plan"),
			WFC_CLAUDE_BIN: fakeClaude,
			WFC_NPM: path.join(tmp, "npm"),
			WFC_MODULES: "landing",
			...env,
		},
	});

const startup = (cwd = main) => ({
	session_id: RECORD.sessionId,
	hook_event_name: "SessionStart",
	source: "startup",
	cwd,
});

const readCalls = () =>
	fs.existsSync(calls)
		? fs
				.readFileSync(calls, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];

const worktrees = () => path.join(main, ".claude", "worktrees");
const cutNames = () =>
	fs.existsSync(worktrees())
		? fs.readdirSync(worktrees()).filter((n) => !n.startsWith("."))
		: [];

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcjob-")));
	const origin = path.join(tmp, "origin.git");
	main = path.join(tmp, "main");
	seat = path.join(tmp, "seat");
	jobDir = path.join(seat, "jobs", RECORD.daemonShort);
	calls = path.join(tmp, "claude-calls");
	fakeClaude = path.join(tmp, "claude");
	fs.writeFileSync(
		fakeClaude,
		`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({
	args, cwd: process.cwd(),
	configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
	jobDir: process.env.CLAUDE_JOB_DIR ?? null,
	sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null,
}) + "\\n");
const fail = args[0] === "--bg" ? process.env.FAKE_BG_FAIL : process.env.FAKE_RM_FAIL;
if (fail) { process.stderr.write(fail); process.exit(1); }
process.stdout.write(args[0] === "--bg" ? "backgrounded · 1a2b3c4d · copy\\n" : "removed\\n");
`,
	);
	fs.chmodSync(fakeClaude, 0o755);
	fs.writeFileSync(
		path.join(tmp, "npm"),
		`#!/bin/sh\nmkdir node_modules && pwd >> ${shellQuote(path.join(tmp, "npm-calls"))}\n`,
	);
	fs.chmodSync(path.join(tmp, "npm"), 0o755);
	git(tmp, "init", "-q", "--bare", "-b", "main", origin);
	git(tmp, "clone", "-q", origin, main);
	git(main, "config", "user.email", "t@t");
	git(main, "config", "user.name", "t");
	for (const [name, text] of Object.entries({
		".gitignore": "/node_modules\n.claude/worktrees/\n",
		"package.json": "{}\n",
		"package-lock.json": "lock-1\n",
	}))
		fs.writeFileSync(path.join(main, name), text);
	git(main, "add", "-A");
	git(main, "commit", "-qm", "seed");
	git(main, "push", "-q", "origin", "HEAD:main", "HEAD:landing");
	writeRecord(RECORD);
});

afterEach(() => {
	if (fs.existsSync(tmp)) execFileSync("chmod", ["-R", "u+w", tmp]);
	fs.rmSync(tmp, { recursive: true, force: true });
});

it("relaunches a job started in the main checkout in a worktree cut for its prompt, on its own plan, then removes the original", () => {
	const r = run(startup());

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toBe("");
	const [name] = cutNames();
	expect(name).toMatch(/^implement-4340-[0-9a-f]{6}$/);
	const dir = path.join(worktrees(), name);
	expect(git(dir, "rev-parse", "HEAD")).toBe(
		git(main, "rev-parse", "origin/landing"),
	);
	const [launch, removal] = readCalls();
	expect(launch).toEqual({
		args: ["--bg", ...RECORD.respawnFlags, "--", RECORD.intent],
		cwd: dir,
		configDir: seat,
		jobDir: null,
		sessionId: null,
	});
	expect(removal.args).toEqual(["rm", RECORD.daemonShort]);
	expect(readCalls()).toHaveLength(2);
});

it("leaves alone an interactive session, a job already in a worktree, a resume, and a repository without the landing module", () => {
	expect(run(startup(), { CLAUDE_JOB_DIR: undefined }).status).toBe(0);
	expect(run({ ...startup(), source: "resume" }).status).toBe(0);
	expect(run(startup(), { WFC_MODULES: "" }).status).toBe(0);
	expect(readCalls()).toEqual([]);
	expect(cutNames()).toEqual([]);

	const linked = path.join(worktrees(), "already-here");
	git(main, "worktree", "add", "-q", "--detach", linked, "HEAD");
	expect(run(startup(linked), {}, linked).status).toBe(0);
	expect(readCalls()).toEqual([]);
	expect(cutNames()).toEqual(["already-here"]);
});

it("tells the session to work in the cut worktree where the relaunch fails, and removes nothing", () => {
	const r = run(startup(), { FAKE_BG_FAIL: "daemon unreachable" });

	expect(r.status, r.stderr).toBe(0);
	const [name] = cutNames();
	const dir = path.join(worktrees(), name);
	const told = JSON.parse(r.stdout).hookSpecificOutput;
	expect(told.hookEventName).toBe("SessionStart");
	expect(told.additionalContext).toContain(
		"and its relaunch in its own worktree failed: daemon unreachable",
	);
	expect(told.additionalContext).toContain(`Bash \`cd ${dir}\``);
	expect(readCalls().map((c) => c.args[0])).toEqual(["--bg"]);
});

it("tells the original to end at once where it cannot be removed after its copy started", () => {
	const r = run(startup(), { FAKE_RM_FAIL: "no such job" });

	expect(r.status, r.stderr).toBe(0);
	const told = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
	expect(told).toContain("Removing this original copy failed (no such job)");
	expect(told).toContain("end this turn at once");
});

it("fails open, saying why, on a payload it cannot read", () => {
	const r = runInProcess(SCRIPT, [], {
		cwd: main,
		stdin: "not json",
		env: { ...process.env, CLAUDE_JOB_DIR: jobDir },
	});

	expect(r.status).toBe(0);
	expect(r.stdout).toBe("");
	expect(r.stderr).toContain("left the job where it started");
});
