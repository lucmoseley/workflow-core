// @vitest-environment node
/*
 * scripts/start-lander.js end to end (#2405, #4458, #4950): it starts a
 * detached queue lander that lands a queue ref's commit, or that decides a
 * drop owed a decision with no queue ref waiting, and starts none where one
 * runs or nothing waits or is owed.
 *
 * Loosen it and the session-start route starts no lander, two landers race
 * to test and push, or a drop waits on an unrelated push for its decision.
 *
 * Built on a real bare remote and a real detached lander, since what is
 * under test is the detach itself; the tester is gated on a file, so the
 * second start meets a lander still holding the lock.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pidAlive } from "./lib/arbiter-proc.js";
import { OWN_CORE, seedAdopterTree } from "./lib/lander-testkit";
import { runInProcess } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";

const START = path.resolve(__dirname, "../scripts/start-lander.js");
/* A guess: a lander run here takes well under a second. */
const WAIT_MS = 30_000;

let tmp: string;
let work: string;
let remote: string;
/** Every lander a start reported, so teardown waits on one a failed case
 * left too, and never removes `tmp` under a live lander (#5444). */
let landers: number[];

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A commit on `work`'s HEAD, pushed as `queue/<message>`. */
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
	git(work, "push", "-q", "origin", `HEAD:refs/heads/queue/${message}`);
	return git(work, "rev-parse", "HEAD");
};

const markers = () => path.join(work, ".claude", "tmp", "markers");
const landerPidFile = () => path.join(markers(), ".lander.pid");

const gatedTester = (release: string) => {
	const script = path.join(tmp, "tester.sh");
	fs.writeFileSync(
		script,
		`#!/bin/sh\nwhile [ ! -e ${shellQuote(release)} ]; do sleep 0.05; done\nexit 0\n`,
	);
	fs.chmodSync(script, 0o755);
	return script;
};

const start = (args: string[]) => {
	const r = runInProcess(START, args, {
		cwd: work,
		env: {
			...process.env,
			WFC_MODULES: "",
			CLAUDE_PROJECT_DIR: work,
			/* As no session, so the start reads no real `claude agents`. */
			CLAUDE_CODE_SESSION_ID: "",
		},
	});
	const pid = /; pid (\d+);/.exec(r.stdout)?.[1];
	if (pid !== undefined) landers.push(Number(pid));
	return r;
};

/* Crosses the real clock: the lander is a detached process. */
const waitFor = async (done: () => boolean) => {
	for (let waited = 0; waited < WAIT_MS && !done(); waited += 100)
		await new Promise((resolve) => setTimeout(resolve, 100));
	return done();
};

const hasEveryLanderExited = () =>
	landers.every((pid) => !pidAlive(pid)) && !fs.existsSync(landerPidFile());

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "start-lander-"));
	remote = path.join(tmp, "remote.git");
	work = path.join(tmp, "work");
	git(tmp, "init", "-q", "--bare", "-b", "main", remote);
	git(tmp, "clone", "-q", remote, work);
	seedAdopterTree(work);
	vi.stubEnv("WORKFLOW_CORE_DIR", OWN_CORE);
	/* A no-op levelling pass: the real one, detached after a move of main,
	 * would fetch into `work` past the lander's exit (#5444). The testkit's
	 * levelStub() writes under a tmp this file never sets up. */
	const level = path.join(tmp, "level-stub.js");
	fs.writeFileSync(level, "");
	vi.stubEnv("WFC_LEVEL_MAIN_SCRIPT", level);
	landers = [];
	commit("seed");
	git(work, "push", "-q", "origin", "HEAD:main", ":refs/heads/queue/seed");
});

afterEach(async () => {
	fs.writeFileSync(path.join(tmp, "release"), "");
	expect(
		await waitFor(hasEveryLanderExited),
		`landers still alive: ${landers}`,
	).toBe(true);
	fs.rmSync(tmp, { recursive: true, force: true });
});

it("starts one detached queue lander that lands the queue ref, and none beside it", async () => {
	const sha = commit("work");
	const release = path.join(tmp, "release");
	const tester = gatedTester(release);

	const first = start(["--tester", tester]);
	expect(first.status, first.stderr).toBe(0);
	expect(first.stdout).toMatch(
		/^\S+Z started the queue lander, 1 queue ref\(s\) waiting: queue\/work, 0 drop\(s\) owed a decision \(launched by no session; pid \d+; code [0-9a-f]{40}\); its output: /,
	);
	await waitFor(() => fs.existsSync(landerPidFile()));

	const second = start(["--tester", tester]);
	expect(second.stdout).toMatch(
		/^SKIP: a lander is already running \(pid \d+\)/,
	);

	fs.writeFileSync(release, "");
	expect(await waitFor(() => git(remote, "rev-parse", "main") === sha)).toBe(
		true,
	);
	expect(await waitFor(hasEveryLanderExited)).toBe(true);
	expect(fs.statSync(path.join(markers(), ".lander.log")).size).toBeGreaterThan(
		0,
	);
});

/** The drop record holding one drop of `queue/gone` at `sha`, as `over` has it. */
const recordDrop = (sha: string, over: Record<string, unknown> = {}) => {
	fs.mkdirSync(markers(), { recursive: true });
	fs.writeFileSync(
		path.join(markers(), ".queue-lander-drops.json"),
		JSON.stringify([
			{
				name: "gone",
				sha,
				ref: "dropped/gone",
				onto: sha,
				cause: { kind: "conflict", name: "gone", files: ["x.txt"] },
				ticket: null,
				at: 1,
				state: "open",
				decidedAt: 1,
				...over,
			},
		]),
	);
};

it("starts a lander with no queue ref waiting where a drop is owed a decision, which settles one main already holds", async () => {
	const main = git(remote, "rev-parse", "main");
	git(work, "push", "-q", "origin", `${main}:refs/heads/dropped/gone`);
	recordDrop(main);

	const r = start(["--tester", "true"]);

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toMatch(
		/^\S+Z started the queue lander, 0 queue ref\(s\) waiting, 1 drop\(s\) owed a decision: dropped\/gone \(launched by no session; pid \d+; code [0-9a-f]{40}\); its output: /,
	);
	expect(
		await waitFor(() => git(remote, "branch", "--list", "dropped/gone") === ""),
	).toBe(true);
	expect(await waitFor(hasEveryLanderExited)).toBe(true);
});

it("starts none where no queue ref waits and every drop is settled or ticketed", () => {
	recordDrop("a".repeat(40), { ticket: 7, state: "ticketed" });

	const r = start(["--tester", "true"]);

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toBe(
		"SKIP: no queue ref waits and no drop is owed a decision\n",
	);
	expect(fs.existsSync(path.join(markers(), ".lander.log"))).toBe(false);
});
