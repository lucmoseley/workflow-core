// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pidAlive } from "./lib/arbiter-proc.js";
import { defineTemplate } from "./lib/git-fixture";
import { OWN_CORE, seedAdopterTree } from "./lib/lander-testkit";
import { runInProcess } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";

const START = path.resolve(__dirname, "../scripts/start-lander.js");
const WAIT_MS = 30_000;

let tmp: string;
let work: string;
let remote: string;
let landers: number[];

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const commitIn = (dir: string, message: string) => {
	fs.writeFileSync(path.join(dir, `${message}.txt`), message);
	git(dir, "add", "-A");
	git(
		dir,
		"-c",
		"user.email=t@t",
		"-c",
		"user.name=t",
		"commit",
		"-qm",
		message,
	);
	git(dir, "push", "-q", "origin", `HEAD:refs/heads/queue/${message}`);
	return git(dir, "rev-parse", "HEAD");
};

const commit = (message: string) => commitIn(work, message);

const template = defineTemplate((dir) => {
	const bare = path.join(dir, "remote.git");
	const clone = path.join(dir, "work");
	git(dir, "init", "-q", "--bare", "-b", "main", bare);
	git(dir, "clone", "-q", bare, clone);
	seedAdopterTree(clone);
	commitIn(clone, "seed");
	git(clone, "push", "-q", "origin", "HEAD:main", ":refs/heads/queue/seed");
});

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
			CLAUDE_CODE_SESSION_ID: "",
		},
	});
	const pid = /; pid (\d+);/.exec(r.stdout)?.[1];
	if (pid !== undefined) landers.push(Number(pid));
	return r;
};

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
	template.instantiate(tmp);
	vi.stubEnv("WORKFLOW_CORE_DIR", OWN_CORE);
	const level = path.join(tmp, "level-stub.js");
	fs.writeFileSync(level, "");
	vi.stubEnv("WFC_LEVEL_MAIN_SCRIPT", level);
	landers = [];
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

it("starts the lander unwrapped where the user scope is refused after the probe allowed it, reporting the pid that runs, as a start the scope allows does (#5613)", async () => {
	commit("work");
	const tester = gatedTester(path.join(tmp, "release"));
	const refusing = path.join(tmp, "systemd-run");
	fs.writeFileSync(
		refusing,
		'#!/bin/sh\nfor last; do :; done\n[ "$last" = true ] && exit 0\necho "Failed to start transient scope unit" >&2\nexit 1\n',
	);
	fs.chmodSync(refusing, 0o755);
	vi.stubEnv("WFC_SYSTEMD_RUN", refusing);

	const r = start(["--tester", tester]);
	expect(r.status, r.stderr).toBe(0);
	const pid = Number(/; pid (\d+);/.exec(r.stdout)?.[1]);
	expect(await waitFor(() => fs.existsSync(landerPidFile()))).toBe(true);
	expect(fs.readFileSync(landerPidFile(), "utf8")).toContain(String(pid));
	expect(fs.readFileSync(path.join(markers(), ".lander.log"), "utf8")).toMatch(
		/Failed to start transient scope unit\n.*the user scope was refused: systemd-run it ended 1 \(#5613\)\n.*no user scope/,
	);
});

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
