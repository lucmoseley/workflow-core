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
	adoptedLine,
	attachThenRelease,
	isSessionProcess,
	membersOf,
	outlivesMark,
	releaseUnitArgs,
	straysOf,
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
		[950, { ppid: 500, startTicks: 170 }],
		[960, { ppid: 1, startTicks: 180 }],
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
		960: "500",
	};
	const outlives: Record<number, string> = { 950: "500:2700", 960: "999:" };
	const got = membersOf({
		procs,
		leader: 500,
		home: Home,
		self: 900,
		readCgroup: (p: number) => cgroups[p] ?? Home,
		readClaudePid: (p: number) => claudePid[p] ?? null,
		readOutlives: (p: number) => outlives[p] ?? null,
	});

	it("takes the descendants and the orphans whose environ names the leader, another session's outliving mark no bar", () => {
		expect(got).toEqual([501, 502, 600, 960]);
	});

	it("leaves a child in a scope of its own, another session's process, a leftover on a reused pid, itself, the leader and its outliving job", () => {
		for (const pid of [601, 700, 800, 900, 500, 950])
			expect(got).not.toContain(pid);
	});
});

describe("straysOf", () => {
	it("groups the leader's marked jobs in its scope under their outermost marked ancestor", () => {
		const Scope = "/s/wfc-session-500-100.scope";
		const procs = new Map([
			[500, { ppid: 400, startTicks: 100 }],
			[600, { ppid: 501, startTicks: 120 }],
			[601, { ppid: 600, startTicks: 130 }],
			[602, { ppid: 601, startTicks: 140 }],
			[700, { ppid: 1, startTicks: 150 }],
			[701, { ppid: 1, startTicks: 160 }],
			[702, { ppid: 1, startTicks: 170 }],
		]);
		const outlives: Record<number, string> = {
			600: "500:2700",
			601: "500:2700",
			602: "500:2700",
			700: "500:",
			701: "999:2700",
			702: "500:2700",
		};
		expect(
			straysOf({
				procs,
				leader: 500,
				scope: Scope,
				readCgroup: (p: number) =>
					p === 702 ? "/app.slice/run-u1.scope" : Scope,
				readOutlives: (p: number) => outlives[p] ?? null,
			}),
		).toEqual([
			{ root: 600, startTicks: 120, ceilingS: 2700, pids: [600, 601, 602] },
			{ root: 700, startTicks: 150, ceilingS: null, pids: [700] },
		]);
	});
});

/*
 * #4749's race, driven through injected cgroup reads: an outliving job's own
 * `systemd-run --scope` execs (its mark appears) and moves it out at each
 * point of the attach, and it must end outside the session's scope.
 */
describe("attachThenRelease's release", () => {
	const Home = "/non-systemd";
	const Scope = "/s/wfc-sessions.slice/wfc-session-500-100.scope";
	const Run = "/s/app.slice/run-u7.scope";
	type Point = "start" | "gap" | "attached" | "end";

	function race(exec: Point, move: Point) {
		const procs = new Map([
			[500, { ppid: 400, startTicks: 100 }],
			[501, { ppid: 500, startTicks: 110 }],
			[600, { ppid: 501, startTicks: 120 }],
		]);
		const cgroup = new Map<number, string>([
			[500, Scope],
			[501, Home],
			[600, Home],
		]);
		let marked = false;
		const at = (point: Point) => {
			if (exec === point) marked = true;
			if (move === point) cgroup.set(600, Run);
		};
		const readOutlives = (p: number) =>
			p === 600 && marked ? outlivesMark(500, 2700) : null;
		const released: unknown[] = [];
		at("start");
		const counts = attachThenRelease({
			left: () =>
				membersOf({
					procs,
					leader: 500,
					home: Home,
					self: 900,
					readCgroup: (p: number) => {
						const read = cgroup.get(p) ?? null;
						if (p === 600) at("gap");
						return read;
					},
					readClaudePid: (p: number) => (p === 600 ? "500" : null),
					readOutlives,
				}),
			attach: (pids) => {
				for (const p of pids) cgroup.set(p, Scope);
				at("attached");
				return true;
			},
			strays: () =>
				straysOf({
					procs,
					leader: 500,
					scope: Scope,
					readCgroup: (p: number) => cgroup.get(p) ?? null,
					readOutlives,
				}),
			release: (group) => {
				released.push(group);
				for (const p of group.pids)
					cgroup.set(p, `/s/app.slice/wfc-outlive-${group.root}.scope`);
				return true;
			},
		});
		at("end");
		return { counts, cgroup, released };
	}

	it.each<[Point, Point]>([
		["start", "start"],
		["gap", "gap"],
		["gap", "attached"],
		["attached", "attached"],
		["attached", "end"],
		["end", "end"],
	])(
		"never leaves the job in the session's scope, its exec at %s and its move at %s",
		(exec, move) => {
			const { cgroup } = race(exec, move);
			expect(cgroup.get(600)).not.toBe(Scope);
			expect(cgroup.get(501)).toBe(Scope);
		},
	);

	it("moves a job a pass pulled back in out to a scope of its own, at its ceiling", () => {
		const { counts, cgroup, released } = race("gap", "gap");
		expect(released).toEqual([
			{ root: 600, startTicks: 120, ceilingS: 2700, pids: [600] },
		]);
		expect(cgroup.get(600)).toBe("/s/app.slice/wfc-outlive-600.scope");
		expect(counts).toEqual({ moved: 2, released: 1, kept: [] });
	});

	/* A job pulled back in runs in the scope until its release, and a child it
	 * forks there, or a group refused for a pid that exited, is met by a later
	 * read. */
	it("releases what a later read finds, and names what it never could", () => {
		const procs = new Map([[600, { ppid: 1, startTicks: 120 }]]);
		const cgroup = new Map([[600, Scope]]);
		const tries: number[][] = [];
		const counts = attachThenRelease({
			left: () => [],
			attach: () => true,
			strays: () =>
				straysOf({
					procs,
					leader: 500,
					scope: Scope,
					readCgroup: (p: number) => cgroup.get(p) ?? null,
					readOutlives: () => outlivesMark(500, 2700),
				}),
			release: ({ pids }) => {
				tries.push(pids);
				if (tries.length === 1) {
					/* Refused; meanwhile 600 forks 601, and 602 appears, in the scope. */
					procs.set(601, { ppid: 600, startTicks: 130 });
					procs.set(602, { ppid: 1, startTicks: 140 });
					cgroup.set(601, Scope).set(602, Scope);
					return false;
				}
				if (pids.includes(602)) return false;
				for (const p of pids) cgroup.set(p, "/s/app.slice/out.scope");
				return true;
			},
		});
		expect(tries.slice(0, 3)).toEqual([[600], [600, 601], [602]]);
		expect(counts).toEqual({ moved: 0, released: 2, kept: [602] });
	});
});

describe("releaseUnitArgs", () => {
	it("asks for a collected scope of the group's pids, at its ceiling or none", () => {
		const group = { root: 600, startTicks: 120, pids: [600, 601] };
		expect(releaseUnitArgs({ ...group, ceilingS: 2700 }).join(" ")).toBe(
			"StartTransientUnit ssa(sv)a(sa(sv)) wfc-outlive-600-120.scope fail 3 PIDs au 2 600 601 CollectMode s inactive-or-failed RuntimeMaxUSec t 2700000000 0",
		);
		expect(releaseUnitArgs({ ...group, ceilingS: null }).join(" ")).toBe(
			"StartTransientUnit ssa(sv)a(sa(sv)) wfc-outlive-600-120.scope fail 2 PIDs au 2 600 601 CollectMode s inactive-or-failed 0",
		);
	});
});

describe("adoptedLine", () => {
	it("is not ok where an outliving job stays in the scope", () => {
		expect(
			adoptedLine(500, "u.scope", { moved: 2, released: 1, kept: [] }),
		).toEqual({
			ok: true,
			line: "session 500 in u.scope, with 2 other process(es), 1 outliving job process(es) moved back out",
		});
		expect(
			adoptedLine(500, "u.scope", { moved: 2, released: 0, kept: [602] }),
		).toMatchObject({
			ok: false,
			line: expect.stringMatching(/ 602 left in it/),
		});
	});
});

describe("attachThenRelease's attach", () => {
	const none = { strays: () => [], release: () => true };

	it("retries a refused batch a pid at a time, and passes again for what forked meanwhile", () => {
		const outside = [[501, 600], [502], []];
		const calls: number[][] = [];
		const { moved } = attachThenRelease({
			left: () => outside.shift() ?? [],
			attach: (pids) => {
				calls.push(pids);
				return pids.length === 1;
			},
			...none,
		});
		expect(moved).toBe(3);
		expect(calls).toEqual([[501, 600], [501], [600], [502]]);
	});

	it("stops after its last pass however much is left", () => {
		let passes = 0;
		attachThenRelease({
			left: () => {
				passes++;
				return [501];
			},
			attach: () => true,
			...none,
		});
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

	it("journals the scope's peak and OOM kills once its leader is gone", () => {
		const m = fakeMachine({});
		fs.writeFileSync(path.join(m.dir, "memory.peak"), "3221225472\n");
		fs.writeFileSync(
			path.join(m.dir, "memory.events"),
			"low 0\nhigh 0\nmax 4\noom 2\noom_kill 2\noom_group_kill 0\n",
		);
		const r = watch(m.env, "4000", "0");
		expect(r.stdout).toBe("u.scope peaked at 3072 MiB, oom_kill 2\n");
	});

	/* Crosses the real clock (§X9), as the test below does. */
	it("journals the peak it polled while its leader lived, the scope gone since", async () => {
		const m = fakeMachine({});
		fs.mkdirSync(path.join(m.proc, "4000"), { recursive: true });
		const stat = path.join(m.proc, "4000", "stat");
		fs.writeFileSync(stat, `4000 (a) S ${"0 ".repeat(18)}555 0\n`);
		fs.writeFileSync(path.join(m.dir, "memory.peak"), "1073741824\n");
		fs.writeFileSync(path.join(m.dir, "memory.events"), "oom_kill 1\n");
		const watcher = spawn("sh", ["-c", WATCH, "sh", "4000", "555", "u.scope"], {
			env: m.env,
		});
		cleanups.push(() => watcher.kill("SIGKILL"));
		let out = "";
		watcher.stdout.on("data", (b) => {
			out += String(b);
		});
		const exited = new Promise<number | null>((resolve) =>
			watcher.on("exit", resolve),
		);
		await new Promise((r) => setTimeout(r, 500));
		fs.rmSync(path.join(m.dir, "memory.peak"));
		fs.rmSync(path.join(m.dir, "memory.events"));
		fs.rmSync(stat);
		expect(await exited).toBe(0);
		expect(out).toBe("u.scope peaked at 1024 MiB, oom_kill 1\n");
	});

	it("says the peak was unreadable where the scope held none", () => {
		const m = fakeMachine({});
		const r = watch(m.env, "4000", "0");
		expect(r.stdout).toMatch(/^u\.scope peak unreadable at .*\/scope$/m);
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
