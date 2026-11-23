import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pidAlive } from "./lib/arbiter-proc.js";
import {
	awayLoadEnv,
	epoch,
	awayLoadEvents as events,
	memwatchReading,
} from "./lib/away-load-fixture";
import { gitBinary, gitSpawnOptions } from "./lib/git.js";
import { defineTemplate, initGitRepo } from "./lib/git-fixture";
import { keptSpawn } from "./lib/kept-spawn.js";
import { runInProcessAsync } from "./lib/run-in-process.js";
import { writeSystemctl } from "./lib/systemctl-fake";
import { writeWevtutil } from "./lib/wevtutil-fake";
import { writeWindowsTasks } from "./lib/windows-tasks-fake";

const SCRIPT = path.join(__dirname, "away-load.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "away-load-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
// guess: many polls of the 100 ms loop on a loaded machine, #5472
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
	const tasks = writeWindowsTasks(dir);
	const files = {
		calls: tasks.calls,
		held: tasks.args,
		workers: path.join(dir, "worker.pids"),
		holders: tasks.pids,
	};
	const env = {
		CLAUDE_PROJECT_DIR: tmp,
		...awayLoadEnv(dir, tasks),
		WFC_SYSTEMCTL: writeSystemctl(dir, {}),
		WFC_AWAY_LOAD_WORKER: `echo $$ >> "${files.workers}"; exec sleep 600`,
		WFC_AWAY_LOAD_REPOS_ROOT: path.join(dir, "home"),
	};
	return { dir, env, files, tasks };
}

const GATE = {
	ticket: 5473,
	since: "2026-11-24T09:01",
	minutes: 988,
	resetAfter: "2026-11-11T17:26:26",
};

function writeGate(env: Record<string, string>, gate: object = GATE) {
	fs.mkdirSync(env.WFC_AWAY_LOAD_STATE_DIR, { recursive: true });
	fs.writeFileSync(
		path.join(env.WFC_AWAY_LOAD_STATE_DIR, "gate.json"),
		`${JSON.stringify(gate)}\n`,
	);
}

const read = (file: string) =>
	fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";

const isGone = (pid: number) => !pidAlive(pid);
const readPids = (file: string) => read(file).trim().split("\n").map(Number);

async function until(what: string, test: () => boolean) {
	const deadline = Date.now() + WAIT_MS;
	while (!test()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

describe("run", () => {
	it("starts on 15 idle minutes, holds and loads, and stops on input", async () => {
		const { env, files } = rig("run");
		writeGate(env);
		fs.writeFileSync(env.MEMWATCH_WIN_OUT, memwatchReading(epoch(), 1100, 900));
		const child = keptSpawn("signal").spawn("node", [SCRIPT, "run"], {
			env: { ...process.env, ...env },
			stdio: "ignore",
		});
		const exited = new Promise((r) => child.on("exit", r));
		try {
			await until("the start", () =>
				events(env.WFC_AWAY_LOAD_LOG).some((e) => e.event === "hold"),
			);
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
				memwatchReading(epoch() + 1, 1100, 3),
			);
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
		writeGate(env);
		fs.writeFileSync(env.MEMWATCH_WIN_OUT, memwatchReading(epoch(), 1100, 900));
		let held: number[] = [];
		let oldestKept = false;
		await runUntil(env, "the release", () => {
			if (held.length === 0 && readPids(files.holders).length === 3) {
				held = readPids(files.holders);
				fs.writeFileSync(
					env.MEMWATCH_WIN_OUT,
					memwatchReading(epoch() + 1, 700, 900),
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
		writeGate(env);
		fs.writeFileSync(env.MEMWATCH_WIN_OUT, memwatchReading(epoch(), 1100, 900));
		let held: number[] = [];
		await runUntil(env, "the strays", () => {
			if (held.length === 0 && readPids(files.holders).length === 3) {
				held = readPids(files.holders);
				tasks.setStrays(1);
				fs.writeFileSync(
					env.MEMWATCH_WIN_OUT,
					memwatchReading(epoch() + 1, 800, 900),
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
		expect(read(files.calls).match(/\/IM Testlimit64.exe \/F/g)).toHaveLength(
			3,
		);
	});

	it("logs the gate met while it waits, and writes the end", async () => {
		const { env } = rig("finish");
		writeGate(env);
		fs.writeFileSync(env.MEMWATCH_WIN_OUT, memwatchReading(epoch(), 1100, 3));
		const row = JSON.stringify({
			ts: "2026-11-24T19:00:00+0800",
			cpu_busy_pct: 600,
			win_avail_mb: 800,
		});
		fs.writeFileSync(env.MEMWATCH_MINUTE_LOG, `${row}\n`.repeat(988));
		await runUntil(env, "the finish", () =>
			events(env.WFC_AWAY_LOAD_LOG).some((e) => e.event === "finish"),
		);
		expect(read(path.join(env.WFC_AWAY_LOAD_STATE_DIR, "done"))).toContain(
			"988 of 988 precondition minutes (#5473)",
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
			{
				event: "recover-unread",
				error: expect.stringContaining("Access is denied"),
			},
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
		writeGate(env);
		await recover(rigged, "2026-11-11T17:26:26");
		const r = await recover(rigged, "2026-11-22T03:00:00");
		expect(r.status).toBe(0);
		const logged = events(env.WFC_AWAY_LOAD_LOG);
		expect(logged.map((e) => e.event)).toEqual(["reset", "fsck"]);
		expect(logged[1]).toMatchObject({ repo, ok: true });
		expect(r.stdout).toContain('"event":"fsck"');
		expect(read(path.join(env.WFC_AWAY_LOAD_STATE_DIR, "done"))).toBe(
			"Kernel-Power 41 at 2026-11-22T03:00:00: the gate met (reset) (#5473)\n",
		);
	});

	it("after a new reset with no gate armed, ends nothing but still logs it", async () => {
		const rigged = rig("recover-unarmed");
		const { env } = rigged;
		fs.mkdirSync(env.WFC_AWAY_LOAD_REPOS_ROOT);
		await recover(rigged, "2026-11-11T17:26:26");
		await recover(rigged, "2026-11-22T03:00:00");
		expect(events(env.WFC_AWAY_LOAD_LOG).map((e) => e.event)).toEqual([
			"reset",
		]);
		expect(fs.existsSync(path.join(env.WFC_AWAY_LOAD_STATE_DIR, "done"))).toBe(
			false,
		);
	});
});

describe("arm and gate", () => {
	const withResets = (
		{ dir, env }: ReturnType<typeof rig>,
		resets: string[],
	) => ({
		...process.env,
		...env,
		WFC_WEVTUTIL: writeWevtutil(path.join(dir, "wevtutil"), [], {
			resets: resets.map((r) => Date.parse(`${r}Z`)),
		}),
	});
	const cli = (args: string[], env: NodeJS.ProcessEnv) =>
		runInProcessAsync(SCRIPT, args, { env });

	it("arms from the next minute past the newest reset, clearing the last run's end", async () => {
		const rigged = rig("arm");
		const state = rigged.env.WFC_AWAY_LOAD_STATE_DIR;
		fs.mkdirSync(state);
		fs.writeFileSync(path.join(state, "done"), "met\n");
		fs.writeFileSync(path.join(state, "hand-until"), "1\n");
		const env = withResets(rigged, ["2026-11-11T17:26:25"]);
		const r = await cli(["arm", "--ticket", "5473", "--minutes", "988"], env);
		expect(r.status).toBe(0);
		const gate = JSON.parse(read(path.join(state, "gate.json")));
		expect(gate).toMatchObject({
			ticket: 5473,
			minutes: 988,
			resetAfter: "2026-11-11T17:26:25",
		});
		expect(gate.since).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d$/);
		expect(fs.existsSync(path.join(state, "done"))).toBe(false);
		expect(fs.existsSync(path.join(state, "hand-until"))).toBe(false);
		expect(read(path.join(state, "seen-reset"))).toBe("2026-11-11T17:26:25\n");
		expect(events(rigged.env.WFC_AWAY_LOAD_LOG)).toMatchObject([
			{ event: "arm", ticket: 5473 },
		]);
	});

	it("refuses an arm without both numbers, writing nothing", async () => {
		const rigged = rig("arm-refused");
		const env = withResets(rigged, []);
		const r = await cli(["arm", "--ticket", "5473"], env);
		expect(r.status).toBe(2);
		expect(
			fs.existsSync(path.join(rigged.env.WFC_AWAY_LOAD_STATE_DIR, "gate.json")),
		).toBe(false);
	});

	it("reads the armed gate: unarmed, unmet, then met on a later reset", async () => {
		const rigged = rig("gate");
		const { env: base } = rigged;
		const unarmed = await cli(["gate"], withResets(rigged, []));
		expect(unarmed.stdout).toMatch(/^unarmed: no gate in /);
		writeGate(base);
		const row = (ts: string) =>
			JSON.stringify({ ts, cpu_busy_pct: 600, win_avail_mb: 800 });
		fs.writeFileSync(
			base.MEMWATCH_MINUTE_LOG,
			`${[row("2026-11-24T09:00:00+0800"), row("2026-11-24T09:01:00+0800"), row("2026-11-24T09:02:00+0800")].join("\n")}\n`,
		);
		const unmet = await cli(
			["gate"],
			withResets(rigged, ["2026-11-11T17:26:26"]),
		);
		expect(unmet.stdout).toBe(
			"unmet: 2 of 988 precondition minutes since 2026-11-24 09:01 (#5473); newest Kernel-Power 41 at 2026-11-11T17:26:26 (local time)\n",
		);
		const met = await cli(
			["gate"],
			withResets(rigged, ["2026-11-24T10:00:00"]),
		);
		expect(met.stdout).toMatch(/^met \(reset\): 2 of 988/);
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
		expect(r.stdout).toContain("gate: none armed");
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
