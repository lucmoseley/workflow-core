// @vitest-environment node
/*
 * scripts/start-lander.js end to end (#2405): it starts a detached lander that
 * lands a pushed commit, and starts none where one runs, `landing` is level
 * with `main` or the module is off.
 *
 * Loosen it and the session-start route starts no lander, or two landers
 * race to test and push.
 *
 * Built on a real bare remote and a real detached lander, since what is
 * under test is the detach itself; the tester is gated on a file, so the
 * second start meets a lander still holding the lock.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const START = path.resolve(__dirname, "../scripts/start-lander.js");
/* A guess: a lander run here takes well under a second. */
const WAIT_MS = 30_000;

let tmp: string;
let work: string;
let remote: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const commit = (message: string) => {
	fs.writeFileSync(path.join(work, `${message}.txt`), message);
	git(work, "add", "-A");
	git(
		work,
		"-c",
		"user.email=t@t",
		"-c",
		"user.name=t",
		"commit",
		"-qm",
		message,
	);
	git(work, "push", "-q", "origin", "HEAD:landing");
	return git(work, "rev-parse", "HEAD");
};

const markers = () => path.join(work, ".claude", "tmp", "markers");

const gatedTester = (release: string) => {
	const script = path.join(tmp, "tester.sh");
	fs.writeFileSync(
		script,
		`#!/bin/sh\nwhile [ ! -e "${release}" ]; do sleep 0.05; done\nexit 0\n`,
	);
	fs.chmodSync(script, 0o755);
	return script;
};

const start = (args: string[], modules = "landing") =>
	runInProcess(START, args, {
		cwd: work,
		env: {
			...process.env,
			WFC_MODULES: modules,
			CLAUDE_PROJECT_DIR: work,
			/* As no session, so the start reads no real `claude agents`. */
			CLAUDE_CODE_SESSION_ID: "",
		},
	});

/* Crosses the real clock: the lander is a detached process. */
const waitFor = async (done: () => boolean) => {
	for (let waited = 0; waited < WAIT_MS && !done(); waited += 100)
		await new Promise((resolve) => setTimeout(resolve, 100));
	return done();
};

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "start-lander-"));
	remote = path.join(tmp, "remote.git");
	work = path.join(tmp, "work");
	git(tmp, "init", "-q", "--bare", "-b", "main", remote);
	git(tmp, "clone", "-q", remote, work);
	commit("seed");
	git(work, "push", "-q", "origin", "HEAD:main");
});

afterEach(() => {
	fs.writeFileSync(path.join(tmp, "release"), "");
	fs.rmSync(tmp, { recursive: true, force: true });
});

it("starts one detached lander that lands the push, and none beside it", async () => {
	const sha = commit("work");
	const release = path.join(tmp, "release");
	const tester = gatedTester(release);

	const first = start(["--tester", tester]);
	expect(first.status, first.stderr).toBe(0);
	expect(first.stdout).toMatch(
		new RegExp(
			`^\\S+Z started the lander, testing ${sha.slice(0, 9)} \\(launched by no session; pid \\d+\\); its output: `,
		),
	);
	await waitFor(() => fs.existsSync(path.join(markers(), ".lander.pid")));

	const second = start(["--tester", tester]);
	expect(second.stdout).toMatch(
		/^SKIP: a lander is already running \(pid \d+\)/,
	);

	fs.writeFileSync(release, "");
	expect(await waitFor(() => git(remote, "rev-parse", "main") === sha)).toBe(
		true,
	);
	expect(fs.statSync(path.join(markers(), ".lander.log")).size).toBeGreaterThan(
		0,
	);
});

it("starts none where landing is level with main", () => {
	const r = start(["--tester", "true"]);

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toBe("SKIP: landing equals main\n");
	expect(fs.existsSync(path.join(markers(), ".lander.log"))).toBe(false);
});

it("does nothing with the landing module off", () => {
	commit("work");

	const r = start(["--tester", "true"], "suites");

	expect(r.status).toBe(0);
	expect(r.stdout).toContain('SKIP: module "landing" is off');
	expect(fs.existsSync(path.join(markers(), ".lander.log"))).toBe(false);
});
