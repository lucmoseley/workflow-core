// @vitest-environment node
// Drives the away-only load (#5472) as a program against fakes of Testlimit,
// taskkill, tasklist and wevtutil at their WFC_ variables: a start on 15 idle minutes
// holds memory and starts CPU workers, input stops both and logs the pair,
// and after a new Kernel-Power 41 `recover` ends the runner and runs git fsck
// in each repo. Break it and the load either never starts, or keeps loading
// the laptop after the founder is back or after #5346 is already answered.
//
// `run` is a loop a signal ends, so its cases cross the real clock: the
// loop's own poll, bounded.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pidAlive } from "./lib/arbiter-proc.js";
import { gitBinary, gitSpawnOptions } from "./lib/git.js";
import { defineTemplate, initGitRepo } from "./lib/git-fixture";
import { keptSpawn } from "./lib/kept-spawn.js";
import { runInProcessAsync } from "./lib/run-in-process.js";
import { writeWevtutil } from "./lib/wevtutil-fake";
import { writeWindowsTasks } from "./lib/windows-tasks-fake";

const SCRIPT = path.join(__dirname, "away-load.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "away-load-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
/* Untraced: many polls of the 100 ms loop on a loaded machine. */
const WAIT_MS = 20_000;

const repoTemplate = defineTemplate((dir) => {
	const none = path.join(dir, ".git-no-hooks");
	fs.mkdirSync(none);
	initGitRepo(dir, none);
	fs.rmdirSync(none);
});

function rig(name: string) {
	const dir = path.join(tmp, name);
	fs.mkdirSync(dir);
	const fake = (file: string, body: string) => {
		fs.writeFileSync(path.join(dir, file), `#!/bin/sh\n${body}\n`, {
			mode: 0o755,
		});
		return path.join(dir, file);
	};
	const tasks = writeWindowsTasks(dir, { calls: path.join(dir, "calls") });
	const files = {
		calls: tasks.calls,
		held: tasks.args,
		workers: path.join(dir, "worker.pids"),
		holders: tasks.pids,
	};
	const env = {
		CLAUDE_PROJECT_DIR: tmp,
		WFC_AWAY_LOAD_STATE_DIR: path.join(dir, "state"),
		WFC_AWAY_LOAD_LOG: path.join(dir, "away-load.jsonl"),
		WFC_AWAY_LOAD_POLL_MS: "100",
		MEMWATCH_WIN_OUT: path.join(dir, "memwatch-win"),
		MEMWATCH_MINUTE_LOG: path.join(dir, "minute.jsonl"),
		WFC_TESTLIMIT: tasks.testlimit,
		WFC_TASKKILL: tasks.taskkill,
		WFC_TASKLIST: tasks.tasklist,
		WFC_SYSTEMCTL: fake("systemctl", `echo "$*" >> "${files.calls}"; exit 1`),
		WFC_AWAY_LOAD_WORKER: `echo $$ >> "${files.workers}"; exec sleep 600`,
		WFC_AWAY_LOAD_REPOS_ROOT: path.join(dir, "home"),
	};
	return { dir, env, files, tasks };
}

const read = (file: string) =>
	fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
const events = (log: string) =>
	read(log)
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));

const isGone = (pid: number) => !pidAlive(pid);
const readPids = (file: string) => read(file).trim().split("\n").map(Number);

async function until(what: string, test: () => boolean) {
	const deadline = Date.now() + WAIT_MS;
	while (!test()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

const epoch = () => Math.floor(Date.now() / 1000);

describe("run", () => {
	it("starts on 15 idle minutes, holds and loads, and stops on input", async () => {
		const { env, files } = rig("run");
		fs.writeFileSync(env.MEMWATCH_WIN_OUT, `${epoch()} 1100 1 2 60 100 900\n`);
		const child = keptSpawn("signal").spawn("node", [SCRIPT, "run"], {
			env: { ...process.env, ...env },
			stdio: "ignore",
		});
		const exited = new Promise((r) => child.on("exit", r));
		try {
			await until("the start", () =>
				events(env.WFC_AWAY_LOAD_LOG).some((e) => e.event === "hold"),
			);
			/* A CPU minute only after the start: the first read takes the log whole. */
			fs.writeFileSync(
				env.MEMWATCH_MINUTE_LOG,
				`${JSON.stringify({ ts: "2026-11-21T19:00:00+0800", cpu_busy_pct: 300, load1: 6 })}\n`,
			);
			await until(
				"the workers",
				() => read(files.workers).trim().split("\n").length === 4,
			);
			expect(read(files.held)).toBe(
				"-accepteula -d 64 -c 2\n-accepteula -d 64 -c 2\n-accepteula -d 64 -c 1\n",
			);

			fs.writeFileSync(
				env.MEMWATCH_WIN_OUT,
				`${epoch() + 1} 1100 1 2 60 100 3\n`,
			);
			/* The stop is logged, then the holders and workers ended. */
			await until("the stop", () =>
				events(env.WFC_AWAY_LOAD_LOG).some((e) => e.event === "stop"),
			);
			expect(events(env.WFC_AWAY_LOAD_LOG).map((e) => e.event)).toEqual([
				"start",
				"hold",
				"workers",
				"stop",
			]);
			expect(events(env.WFC_AWAY_LOAD_LOG).at(-1)).toMatchObject({
				why: "Windows input 3 s before the reading",
				heldMb: 320,
				workers: 4,
			});
			const pids = [...readPids(files.workers), ...readPids(files.holders)];
			await until("the workers' and holders' end", () => pids.every(isGone));
			expect(read(files.calls)).toContain("/IM Testlimit64.exe /F");
		} finally {
			child.kill("SIGTERM");
			await exited;
		}
	});
});

describe("run, by its readings", () => {
	/** Runs the loop until `test` holds, then ends it with SIGTERM. */
	async function runUntil(
		env: Record<string, string>,
		what: string,
		test: () => boolean,
	) {
		const child = keptSpawn("signal").spawn("node", [SCRIPT, "run"], {
			env: { ...process.env, ...env },
			stdio: "ignore",
		});
		const exited = new Promise((r) => child.on("exit", r));
		try {
			await until(what, test);
		} finally {
			child.kill("SIGTERM");
			await exited;
		}
	}

	it("releases only the newest holders, about the shortfall (#5472, where a release ended them all)", async () => {
		const { env, files } = rig("release");
		fs.writeFileSync(env.MEMWATCH_WIN_OUT, `${epoch()} 1100 1 2 60 100 900\n`);
		let held: number[] = [];
		let oldestKept = false;
		await runUntil(env, "the release", () => {
			if (held.length === 0 && readPids(files.holders).length === 3) {
				held = readPids(files.holders);
				fs.writeFileSync(
					env.MEMWATCH_WIN_OUT,
					`${epoch() + 1} 700 1 2 60 100 900\n`,
				);
			}
			const released =
				events(env.WFC_AWAY_LOAD_LOG).some((e) => e.event === "release") &&
				isGone(held[1]) &&
				isGone(held[2]);
			if (released) oldestKept = !isGone(held[0]);
			return released;
		});
		expect(
			events(env.WFC_AWAY_LOAD_LOG).find((e) => e.event === "release"),
		).toMatchObject({ dropMb: 192, heldMb: 128 });
		expect(oldestKept).toBe(true);
	});

	it("ends the whole hold where Windows runs more Testlimits than it holds", async () => {
		const { env, files, tasks } = rig("strays");
		fs.writeFileSync(env.MEMWATCH_WIN_OUT, `${epoch()} 1100 1 2 60 100 900\n`);
		let held: number[] = [];
		await runUntil(env, "the strays", () => {
			if (held.length === 0 && readPids(files.holders).length === 3) {
				held = readPids(files.holders);
				tasks.setStrays(1);
				fs.writeFileSync(
					env.MEMWATCH_WIN_OUT,
					`${epoch() + 1} 800 1 2 60 100 900\n`,
				);
			}
			return (
				events(env.WFC_AWAY_LOAD_LOG).some((e) => e.event === "strays") &&
				held.every(isGone)
			);
		});
		expect(
			events(env.WFC_AWAY_LOAD_LOG).find((e) => e.event === "strays"),
		).toMatchObject({ onWindows: 4, holders: 3 });
		/* The run's opening sweep, the strays' and the SIGTERM's. */
		expect(read(files.calls).match(/\/IM Testlimit64.exe \/F/g)).toHaveLength(
			3,
		);
	});

	it("logs the gate met while it waits, and writes the end", async () => {
		const { env } = rig("finish");
		fs.writeFileSync(env.MEMWATCH_WIN_OUT, `${epoch()} 1100 1 2 60 100 3\n`);
		const row = JSON.stringify({
			ts: "2026-11-21T19:00:00+0800",
			cpu_busy_pct: 600,
			win_avail_mb: 800,
		});
		fs.writeFileSync(env.MEMWATCH_MINUTE_LOG, `${row}\n`.repeat(1308));
		await runUntil(env, "the finish", () =>
			events(env.WFC_AWAY_LOAD_LOG).some((e) => e.event === "finish"),
		);
		expect(read(path.join(env.WFC_AWAY_LOAD_STATE_DIR, "done"))).toContain(
			"1308 of 1308 precondition minutes",
		);
	});
});

describe("recover", () => {
	const recover = (
		{ dir, env }: ReturnType<typeof rig>,
		reset: string,
		{ fails = false } = {},
	) =>
		runInProcessAsync(SCRIPT, ["recover"], {
			env: {
				...process.env,
				...env,
				WFC_WEVTUTIL: writeWevtutil(path.join(dir, "wevtutil"), [], {
					fails,
					resets: [Date.parse(`${reset}Z`)],
				}),
			},
		});

	it("fails the unit's start where the event log will not read", async () => {
		const r = rig("recover-unread");
		const result = await recover(r, "2026-11-11T17:26:26", { fails: true });
		expect(result.status).toBe(1);
		expect(events(r.env.WFC_AWAY_LOAD_LOG)).toMatchObject([
			{ event: "recover-unread", error: expect.stringContaining("exited 1") },
		]);
	});

	it("records the first reading and checks nothing", async () => {
		const rigged = rig("recover-first");
		const { env } = rigged;
		const r = await recover(rigged, "2026-11-11T17:26:26");
		expect(r).toMatchObject({ status: 0, stdout: "" });
		expect(read(path.join(env.WFC_AWAY_LOAD_STATE_DIR, "seen-reset"))).toBe(
			"2026-11-11T17:26:26\n",
		);
		expect(fs.existsSync(path.join(env.WFC_AWAY_LOAD_STATE_DIR, "done"))).toBe(
			false,
		);
	});

	it("after a new reset, ends the runner and runs git fsck in each repo", async () => {
		const rigged = rig("recover-reset");
		const { env } = rigged;
		const repo = path.join(env.WFC_AWAY_LOAD_REPOS_ROOT, "alpha");
		repoTemplate.instantiate(repo);
		fs.mkdirSync(path.join(env.WFC_AWAY_LOAD_REPOS_ROOT, "not-a-repo"));
		await recover(rigged, "2026-11-11T17:26:26");
		const r = await recover(rigged, "2026-11-22T03:00:00");
		expect(r.status).toBe(0);
		const logged = events(env.WFC_AWAY_LOAD_LOG);
		expect(logged.map((e) => e.event)).toEqual(["reset", "fsck"]);
		expect(logged[1]).toMatchObject({ repo, ok: true });
		expect(r.stdout).toContain('"event":"fsck"');
		expect(read(path.join(env.WFC_AWAY_LOAD_STATE_DIR, "done"))).toBe(
			"Kernel-Power 41 at 2026-11-22T03:00:00: the page-combining gate met (reset) (#5346)\n",
		);
	});
});

describe("hand-start", () => {
	it("refuses a hand start of no minutes, writing nothing", async () => {
		const { env } = rig("hand-start");
		const r = await runInProcessAsync(
			SCRIPT,
			["hand-start", "--minutes", "0"],
			{ env: { ...process.env, ...env } },
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("--minutes takes a whole number over 0");
		expect(fs.existsSync(env.WFC_AWAY_LOAD_STATE_DIR)).toBe(false);
	});
});

describe("sweep", () => {
	it("reads no Testlimit running as swept, and any other failure as exit 1", async () => {
		const { dir, env } = rig("sweep");
		const sweep = () =>
			runInProcessAsync(SCRIPT, ["sweep"], {
				env: { ...process.env, ...env },
			});
		expect((await sweep()).status).toBe(0);
		writeWindowsTasks(dir, { denied: true });
		const failed = await sweep();
		expect(failed.status).toBe(1);
		expect(failed.stderr).toContain("Access is denied");
	});
});

describe("status", () => {
	it("names the run's state, its end and the newest reset read", async () => {
		const { env } = rig("status");
		fs.mkdirSync(env.WFC_AWAY_LOAD_STATE_DIR);
		fs.writeFileSync(path.join(env.WFC_AWAY_LOAD_STATE_DIR, "done"), "met\n");
		const r = await runInProcessAsync(SCRIPT, ["status"], {
			env: { ...process.env, ...env },
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("status: none written");
		expect(r.stdout).toContain("done: met");
		expect(r.stdout).toContain("newest Kernel-Power 41 seen: none read");
	});
});

describe("install", () => {
	const install = (dir: string, env: Record<string, string>, gitDir: string) =>
		runInProcessAsync(SCRIPT, ["install"], {
			env: {
				...process.env,
				...env,
				XDG_CONFIG_HOME: path.join(dir, "config"),
				GIT_DIR: gitDir,
			},
		});

	it("refuses a copy git cannot place, writing no unit", async () => {
		const { dir, env, files } = rig("install-none");
		const r = await install(dir, env, path.join(dir, "no-repo"));
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			`install from the main checkout, not ${path.dirname(SCRIPT)}`,
		);
		expect(fs.existsSync(path.join(dir, "config"))).toBe(false);
		expect(read(files.calls)).toBe("");
	});

	it("refuses a linked worktree, which its session removes", async () => {
		const { dir, env, files } = rig("install-linked");
		const repo = path.join(dir, "repo");
		repoTemplate.instantiate(repo);
		const git = (...args: string[]) =>
			execFileSync(gitBinary(), ["-C", repo, ...args], gitSpawnOptions({}));
		git("commit", "-q", "--allow-empty", "-m", "a");
		git("worktree", "add", "-q", path.join(dir, "linked"));
		const r = await install(
			dir,
			env,
			path.join(repo, ".git", "worktrees", "linked"),
		);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("install from the main checkout");
		expect(fs.existsSync(path.join(dir, "config"))).toBe(false);
		expect(read(files.calls)).toBe("");
	});
});
