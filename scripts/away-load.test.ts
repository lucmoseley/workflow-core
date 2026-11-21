// @vitest-environment node
// Drives the away-only load (#5472) as a program against fakes of Testlimit,
// taskkill and wevtutil at their WFC_ variables: a start on 15 idle minutes
// holds memory and starts CPU workers, input stops both and logs the pair,
// and after a new Kernel-Power 41 `recover` ends the runner and runs git fsck
// in each repo. Break it and the load either never starts, or keeps loading
// the laptop after the founder is back or after #5346 is already answered.
//
// spawn-kept: `run` is a loop a signal ends, and the case reads its log while
// it runs. Its waits cross the real clock: the loop's own poll, bounded.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { gitBinary, gitSpawnOptions } from "./lib/git.js";
import { defineTemplate, initGitRepo } from "./lib/git-fixture";
import { runInProcessAsync } from "./lib/run-in-process.js";

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
	const files = {
		calls: path.join(dir, "taskkill.calls"),
		held: path.join(dir, "testlimit.args"),
		workers: path.join(dir, "worker.pids"),
	};
	const env = {
		CLAUDE_PROJECT_DIR: tmp,
		WFC_AWAY_LOAD_STATE_DIR: path.join(dir, "state"),
		WFC_AWAY_LOAD_LOG: path.join(dir, "away-load.jsonl"),
		WFC_AWAY_LOAD_POLL_MS: "100",
		MEMWATCH_WIN_OUT: path.join(dir, "memwatch-win"),
		MEMWATCH_MINUTE_LOG: path.join(dir, "minute.jsonl"),
		WFC_TESTLIMIT: fake(
			"Testlimit64.exe",
			`echo "$*" >> "${files.held}"; echo "Process ID: 4242"; exec sleep 600`,
		),
		WFC_TASKKILL: fake("taskkill", `echo "$*" >> "${files.calls}"`),
		WFC_SYSTEMCTL: fake("systemctl", `echo "$*" >> "${files.calls}"; exit 1`),
		WFC_AWAY_LOAD_WORKER: `echo $$ >> "${files.workers}"; exec sleep 600`,
		WFC_AWAY_LOAD_REPOS_ROOT: path.join(dir, "home"),
	};
	return { dir, env, files };
}

const read = (file: string) =>
	fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
const events = (log: string) =>
	read(log)
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));

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
		// spawn-kept: a signal — SIGTERM ends the run loop.
		const child = spawn("node", [SCRIPT, "run"], {
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
			await until("the stop", () => read(files.calls).includes("/PID 4242 /F"));
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
			expect(read(files.calls)).toContain("/PID 4242 /F");
			expect(read(files.calls)).toContain("/IM Testlimit64.exe /F");
			const pids = read(files.workers).trim().split("\n").map(Number);
			await until("the workers' end", () =>
				pids.every((pid) => {
					try {
						process.kill(pid, 0);
						return false;
					} catch {
						return true;
					}
				}),
			);
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
		// spawn-kept: a signal — SIGTERM ends the run loop.
		const child = spawn("node", [SCRIPT, "run"], {
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

	it("ends every holder where one's Windows pid never read", async () => {
		const { dir, env, files } = rig("blind");
		const testlimit = path.join(dir, "Testlimit64.exe");
		fs.writeFileSync(testlimit, "#!/bin/sh\nexec sleep 600\n", { mode: 0o755 });
		fs.writeFileSync(env.MEMWATCH_WIN_OUT, `${epoch()} 1100 1 2 60 100 900\n`);
		let dipped = false;
		await runUntil({ ...env, WFC_TESTLIMIT: testlimit }, "the release", () => {
			const logged = events(env.WFC_AWAY_LOAD_LOG);
			if (!dipped && logged.some((e) => e.event === "hold")) {
				dipped = true;
				fs.writeFileSync(
					env.MEMWATCH_WIN_OUT,
					`${epoch() + 1} 600 1 2 60 100 900\n`,
				);
			}
			return logged.some((e) => e.event === "release");
		});
		expect(
			events(env.WFC_AWAY_LOAD_LOG).find((e) => e.event === "release"),
		).toMatchObject({
			dropMb: 320,
			heldMb: 0,
			all: "a holder's Windows pid never read",
			swept: null,
		});
		expect(read(files.calls)).toContain("/IM Testlimit64.exe /F");
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
	const recover = (env: Record<string, string>, reset: string) => {
		const wevtutil = path.join(env.WFC_AWAY_LOAD_STATE_DIR, "..", "wevtutil");
		fs.writeFileSync(
			wevtutil,
			`#!/bin/sh\nprintf 'Event[0]:\\r\\n  Date: ${reset}.4670000Z\\r\\n'\n`,
			{ mode: 0o755 },
		);
		return runInProcessAsync(SCRIPT, ["recover"], {
			env: { ...process.env, ...env, WFC_WEVTUTIL: wevtutil },
		});
	};

	it("fails the unit's start where the event log will not read", async () => {
		const { env } = rig("recover-unread");
		const wevtutil = path.join(env.WFC_AWAY_LOAD_STATE_DIR, "..", "wevtutil");
		fs.writeFileSync(
			wevtutil,
			"#!/bin/sh\necho 'Access is denied.' >&2; exit 5\n",
			{
				mode: 0o755,
			},
		);
		const r = await runInProcessAsync(SCRIPT, ["recover"], {
			env: { ...process.env, ...env, WFC_WEVTUTIL: wevtutil },
		});
		expect(r.status).toBe(1);
		expect(events(env.WFC_AWAY_LOAD_LOG)).toMatchObject([
			{
				event: "recover-unread",
				error: expect.stringContaining("Access is denied"),
			},
		]);
	});

	it("records the first reading and checks nothing", async () => {
		const { env } = rig("recover-first");
		const r = await recover(env, "2026-11-11T17:26:26");
		expect(r).toMatchObject({ status: 0, stdout: "" });
		expect(read(path.join(env.WFC_AWAY_LOAD_STATE_DIR, "seen-reset"))).toBe(
			"2026-11-11T17:26:26\n",
		);
		expect(fs.existsSync(path.join(env.WFC_AWAY_LOAD_STATE_DIR, "done"))).toBe(
			false,
		);
	});

	it("after a new reset, ends the runner and runs git fsck in each repo", async () => {
		const { env } = rig("recover-reset");
		const repo = path.join(env.WFC_AWAY_LOAD_REPOS_ROOT, "alpha");
		repoTemplate.instantiate(repo);
		fs.mkdirSync(path.join(env.WFC_AWAY_LOAD_REPOS_ROOT, "not-a-repo"));
		await recover(env, "2026-11-11T17:26:26");
		const r = await recover(env, "2026-11-22T03:00:00");
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
		const taskkill = (body: string) => {
			fs.writeFileSync(path.join(dir, "taskkill"), `#!/bin/sh\n${body}\n`);
			return runInProcessAsync(SCRIPT, ["sweep"], {
				env: { ...process.env, ...env },
			});
		};
		expect(
			(
				await taskkill(
					"echo 'ERROR: The process \"Testlimit64.exe\" not found.' >&2; exit 128",
				)
			).status,
		).toBe(0);
		const failed = await taskkill(
			"echo 'ERROR: Access is denied.' >&2; exit 1",
		);
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
