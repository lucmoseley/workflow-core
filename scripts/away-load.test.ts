// @vitest-environment node
// Drives the away-only load's runner (#5472) against fakes of Testlimit,
// taskkill and wevtutil: a start on 15 idle minutes holds memory and starts
// CPU workers, input stops both and logs the pair, and after a new
// Kernel-Power 41 `recover` runs git fsck in each repo and ends the runner.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { paths, Runner } from "./away-load.js";
import { runInProcessAsync } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "away-load.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "away-load-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A fresh directory of fakes and files, and the environment naming them. */
function rig(name: string) {
	const dir = path.join(tmp, name);
	fs.mkdirSync(dir);
	const calls = path.join(dir, "taskkill.calls");
	const fake = (file: string, body: string) => {
		fs.writeFileSync(path.join(dir, file), `#!/bin/sh\n${body}\n`, {
			mode: 0o755,
		});
		return path.join(dir, file);
	};
	const env = {
		AWAY_LOAD_STATE_DIR: path.join(dir, "state"),
		AWAY_LOAD_LOG: path.join(dir, "away-load.jsonl"),
		MEMWATCH_WIN_OUT: path.join(dir, "memwatch-win"),
		MEMWATCH_MINUTE_LOG: path.join(dir, "minute.jsonl"),
		AWAY_LOAD_TESTLIMIT: fake(
			"Testlimit64.exe",
			'echo "Testlimit v5.24"; echo "Process ID: 4242"; exec sleep 600',
		),
		AWAY_LOAD_TASKKILL: fake("taskkill", `echo "$*" >> "${calls}"`),
		AWAY_LOAD_WORKER: "exec sleep 600",
		AWAY_LOAD_REPOS_ROOT: path.join(dir, "home"),
	};
	return { dir, env, calls };
}

function events(log: string) {
	return fs.existsSync(log)
		? fs
				.readFileSync(log, "utf8")
				.trimEnd()
				.split("\n")
				.map((l) => JSON.parse(l))
		: [];
}

const epoch = () => Math.floor(Date.now() / 1000);
const reading = (idleS: number, availMb: number) =>
	`${epoch()} ${availMb} 1 2 60 100 ${idleS}\n`;

describe("the run", () => {
	it("starts on 15 idle minutes, holds and loads, and stops on input", async () => {
		const { env, calls } = rig("run");
		const runner = new Runner(paths({ ...process.env, ...env }));
		fs.writeFileSync(env.MEMWATCH_WIN_OUT, reading(900, 1500));
		fs.writeFileSync(
			env.MEMWATCH_MINUTE_LOG,
			`${JSON.stringify({ ts: "2026-11-21T19:00:00+0800", cpu_busy_pct: 300, load1: 6, win_avail_mb: 1500 })}\n`,
		);
		try {
			expect(runner.tick().kind).toBe("start");
			expect(runner.holders.map((h: { mb: number }) => h.mb)).toEqual([704]);
			expect(runner.workers).toHaveLength(4);
			const deadline = Date.now() + 10_000;
			while (runner.holders[0].winPid === null && Date.now() < deadline)
				await new Promise((r) => setTimeout(r, 50));
			expect(runner.holders[0].winPid).toBe(4242);
			const workerPids = runner.workers.map((w) => w.pid ?? 0);

			/* Input: the next reading shows 3 s idle. */
			fs.writeFileSync(
				env.MEMWATCH_WIN_OUT,
				`${epoch() + 1} 1500 1 2 60 100 3\n`,
			);
			expect(runner.tick()).toMatchObject({ kind: "stop" });
			expect(runner.holders).toEqual([]);
			expect(runner.workers).toEqual([]);
			expect(fs.readFileSync(calls, "utf8")).toContain("/PID 4242 /F");
			expect(fs.readFileSync(calls, "utf8")).toContain(
				"/IM Testlimit64.exe /F",
			);
			await new Promise((r) => setTimeout(r, 200));
			for (const pid of workerPids)
				expect(() => process.kill(pid, 0)).toThrow();
			const kinds = events(env.AWAY_LOAD_LOG).map((e) => e.event);
			expect(kinds).toEqual(["start", "hold", "workers", "stop"]);
			const status = JSON.parse(
				fs.readFileSync(
					path.join(env.AWAY_LOAD_STATE_DIR, "status.json"),
					"utf8",
				),
			);
			expect(status).toMatchObject({ running: false, heldMb: 0, workers: 0 });
		} finally {
			runner.quit();
		}
	});
});

describe("recover", () => {
	const recover = (env: Record<string, string>, reset: string) => {
		const wevtutil = path.join(env.AWAY_LOAD_STATE_DIR, "..", "wevtutil");
		fs.writeFileSync(
			wevtutil,
			`#!/bin/sh\nprintf 'Event[0]:\\r\\n  Date: ${reset}.4670000Z\\r\\n'\n`,
			{ mode: 0o755 },
		);
		return runInProcessAsync(SCRIPT, ["recover"], {
			env: {
				...process.env,
				...env,
				AWAY_LOAD_WEVTUTIL: wevtutil,
				CLAUDE_PROJECT_DIR: tmp,
			},
		});
	};

	it("records the first reading and checks nothing", async () => {
		const { env } = rig("recover-first");
		expect((await recover(env, "2026-11-11T17:26:26")).status).toBe(0);
		expect(events(env.AWAY_LOAD_LOG)).toEqual([]);
		expect(fs.existsSync(path.join(env.AWAY_LOAD_STATE_DIR, "done"))).toBe(
			false,
		);
	});

	it("after a new reset, runs git fsck in each repo and ends the runner", async () => {
		const { env } = rig("recover-reset");
		const repo = path.join(env.AWAY_LOAD_REPOS_ROOT, "alpha");
		fs.mkdirSync(repo, { recursive: true });
		execFileSync("git", ["init", "-q", repo]);
		fs.mkdirSync(path.join(env.AWAY_LOAD_REPOS_ROOT, "not-a-repo"));
		await recover(env, "2026-11-11T17:26:26");
		expect((await recover(env, "2026-11-22T03:00:00")).status).toBe(0);
		const logged = events(env.AWAY_LOAD_LOG);
		expect(logged.map((e) => e.event)).toEqual(["reset", "fsck"]);
		expect(logged[1]).toMatchObject({ repo, ok: true });
		expect(
			fs.readFileSync(path.join(env.AWAY_LOAD_STATE_DIR, "done"), "utf8"),
		).toContain("gate met (reset)");
	});
});

describe("the command line", () => {
	it("refuses a hand start of no minutes", async () => {
		const { env } = rig("hand-start");
		const r = await runInProcessAsync(
			SCRIPT,
			["hand-start", "--minutes", "0"],
			{
				env: { ...process.env, ...env, CLAUDE_PROJECT_DIR: tmp },
			},
		);
		expect(r.status).toBe(2);
	});
});
