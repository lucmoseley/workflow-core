// @vitest-environment node
/*
 * lib/session-scope.js (#4341): which processes move with a session, the
 * attach retry, and the watcher script, run for real by `sh` against a fake
 * /proc and cgroup directory with its systemd tools stubbed at WFC_SYSTEMCTL
 * and WFC_BUSCTL.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	attachAll,
	isSessionProcess,
	membersOf,
	WATCH,
} from "./session-scope.js";
import { systemctlCalls, writeSystemctl } from "./systemctl-fake";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const f of cleanups.splice(0)) f();
});

function tmp(prefix: string) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

describe("isSessionProcess", () => {
	it("reads a daemon spare's one-word argv, a launcher and a versioned binary", () => {
		expect(isSessionProcess(["claude bg-spare --bg-spare /tmp/s.sock"])).toBe(
			true,
		);
		expect(isSessionProcess(["/home/u/.local/bin/claude", "--bg"])).toBe(true);
		expect(
			isSessionProcess(["/home/u/.local/share/claude/versions/2.1.319"]),
		).toBe(true);
		expect(isSessionProcess(["node", "claude"])).toBe(false);
	});
});

describe("membersOf", () => {
	const Home = "/non-systemd";
	const procs = new Map([
		[500, { ppid: 400, startTicks: 100 }],
		[501, { ppid: 500, startTicks: 110 }],
		[502, { ppid: 501, startTicks: 120 }],
		[600, { ppid: 1, startTicks: 130 }],
		[601, { ppid: 500, startTicks: 140 }],
		[700, { ppid: 1, startTicks: 150 }],
		[800, { ppid: 1, startTicks: 50 }],
		[900, { ppid: 500, startTicks: 160 }],
	]);
	const cgroups: Record<number, string> = {
		601: "/user.slice/user-1000.slice/user@1000.service/app.slice/wfc-test-501-1.scope",
	};
	const claudePid: Record<number, string> = {
		501: "500",
		502: "500",
		600: "500",
		700: "999",
		800: "500",
	};
	const got = membersOf({
		procs,
		leader: 500,
		home: Home,
		self: 900,
		readCgroup: (p: number) => cgroups[p] ?? Home,
		readClaudePid: (p: number) => claudePid[p] ?? null,
	});

	it("takes the descendants and the orphans whose environ names the leader", () => {
		expect(got).toEqual([501, 502, 600]);
	});

	it("leaves a child in a scope of its own, another session's process, a leftover on a reused pid, itself and the leader", () => {
		for (const pid of [601, 700, 800, 900, 500]) expect(got).not.toContain(pid);
	});
});

describe("attachAll", () => {
	it("retries a refused batch a pid at a time, and passes again for what forked meanwhile", () => {
		const outside = [[501, 600], [502], []];
		const calls: number[][] = [];
		const moved = attachAll(
			() => outside.shift() ?? [],
			(pids) => {
				calls.push(pids);
				return pids.length === 1;
			},
		);
		expect(moved).toBe(3);
		expect(calls).toEqual([[501, 600], [501], [600], [502]]);
	});

	it("stops after its last pass however much is left", () => {
		let passes = 0;
		attachAll(
			() => {
				passes++;
				return [501];
			},
			() => true,
		);
		expect(passes).toBe(5);
	});
});

describe("the watcher", () => {
	/**
	 * A fake /proc, a scope cgroup at /scope holding `procs`, a systemctl
	 * (lib/systemctl-fake.ts) that names it and empties it on `kill`, and a
	 * busctl that logs.
	 */
	function fakeMachine(procs: Record<number, string>) {
		const root = tmp("session-scope-w-");
		const proc = path.join(root, "proc");
		const dir = path.join(root, "cg", "scope");
		fs.mkdirSync(dir, { recursive: true });
		for (const [pid, cmdline] of Object.entries(procs)) {
			fs.mkdirSync(path.join(proc, pid), { recursive: true });
			fs.writeFileSync(path.join(proc, pid, "cmdline"), cmdline);
		}
		fs.writeFileSync(
			path.join(dir, "cgroup.procs"),
			Object.keys(procs).join("\n"),
		);
		fs.writeFileSync(path.join(dir, "cgroup.kill"), "");
		const stub = (name: string, body: string) => {
			const file = path.join(root, name);
			fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
			fs.chmodSync(file, 0o755);
			return file;
		};
		const env = {
			...process.env,
			WFC_PROC: proc,
			WFC_CGROUP_ROOT: path.join(root, "cg"),
			WFC_SYSTEMCTL: writeSystemctl(root, {
				units: { "u.scope": { properties: { ControlGroup: "/scope" } } },
				cgroupRoot: path.join(root, "cg"),
			}),
			WFC_BUSCTL: stub("busctl", `echo "$*" >> "${root}/busctl.log"`),
		};
		const read = (name: string) => {
			const file = path.join(root, name);
			return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
		};
		const kills = () =>
			systemctlCalls(root).filter((c) => c.includes(" kill "));
		return { proc, dir, env, read, kills };
	}

	const watch = (env: NodeJS.ProcessEnv, leader: string, start: string) =>
		spawnSync("sh", ["-c", WATCH, "sh", leader, start, "u.scope"], {
			encoding: "utf8",
			env,
		});

	it("kills what is left once its leader is gone, keeping a Claude daemon out", () => {
		const m = fakeMachine({
			4242: "sleep\x00900\x00",
			4243: "/home/u/.local/bin/claude\x00daemon\x00run\x00",
		});
		const r = watch(m.env, "4000", "0");
		expect(r.status).toBe(0);
		expect(m.read("busctl.log")).toMatch(
			/StartTransientUnit .* wfc-claude-4243\.scope fail 2 PIDs au 1 4243 /,
		);
		expect(m.read("busctl.log")).not.toMatch(/4242/);
		expect(r.stdout).toMatch(/killing what is left in u\.scope: 4242 4243/);
		expect(m.kills()).toEqual([
			"systemctl --user kill --signal=SIGTERM u.scope",
		]);
		expect(fs.readFileSync(path.join(m.dir, "cgroup.kill"), "utf8")).toBe(
			"1\n",
		);
	});

	it("reads a leader on a reused pid, its start time changed, as ended", () => {
		const m = fakeMachine({ 4242: "sleep\x00900\x00" });
		fs.mkdirSync(path.join(m.proc, "4000"), { recursive: true });
		fs.writeFileSync(
			path.join(m.proc, "4000", "stat"),
			`4000 (a) b) S ${"0 ".repeat(18)}777 0\n`,
		);
		const r = watch(m.env, "4000", "555");
		expect(r.stdout).toMatch(/session 4000 ended/);
	});

	/* Crosses the real clock (§X9): the watcher is a shell loop on `sleep`,
	 * which no fake clock reaches. */
	it("waits while its leader lives, and leaves an empty scope alone", async () => {
		const m = fakeMachine({});
		fs.mkdirSync(path.join(m.proc, "4000"), { recursive: true });
		const stat = path.join(m.proc, "4000", "stat");
		fs.writeFileSync(stat, `4000 (a) S ${"0 ".repeat(18)}555 0\n`);
		const watcher = spawn("sh", ["-c", WATCH, "sh", "4000", "555", "u.scope"], {
			env: m.env,
		});
		cleanups.push(() => watcher.kill("SIGKILL"));
		const exited = new Promise<number | null>((resolve) =>
			watcher.on("exit", resolve),
		);
		/* One look at the live leader: the watcher must still be waiting. */
		await new Promise((r) => setTimeout(r, 500));
		expect(watcher.exitCode).toBeNull();
		fs.rmSync(stat);
		expect(await exited).toBe(0);
		expect(m.kills()).toEqual([]);
		expect(fs.readFileSync(path.join(m.dir, "cgroup.kill"), "utf8")).toBe("");
	});
});
