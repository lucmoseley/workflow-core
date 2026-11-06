// @vitest-environment node
/*
 * session-scope.js (#4341): which processes move with the session, the
 * user-manager calls the adoption makes, and the watcher's kill.
 *
 * The systemd tools are fakes on PATH that log each call, so no test moves a
 * real process; the watcher runs for real against a fake cgroup directory.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeProcRoot } from "./lib/proc-fake";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "session-scope.js");
const { membersOf, isClaude, WATCH } = require("./session-scope.js");

const NON_SYSTEMD = "/non-systemd";
const SCOPED =
	"/user.slice/user-1000.slice/user@1000.service/wfc.slice/wfc-sessions.slice/wfc-session-500-1.scope";
const SPARE =
	"claude bg-spare --bg-spare /tmp/cc-daemon-1000/x/spare/ab.claim.sock";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const f of cleanups.splice(0)) f();
});

function tmp(prefix: string) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

describe("isClaude", () => {
	it("reads a daemon spare's one-word argv, a launcher and a versioned binary", () => {
		expect(isClaude([SPARE])).toBe(true);
		expect(isClaude(["/home/u/.local/bin/claude", "--bg"])).toBe(true);
		expect(isClaude(["/home/u/.local/share/claude/versions/2.1.319"])).toBe(
			true,
		);
		expect(isClaude(["node", "claude"])).toBe(false);
	});
});

describe("membersOf", () => {
	const procs = new Map([
		[500, { ppid: 400 }],
		[501, { ppid: 500 }],
		[502, { ppid: 501 }],
		[600, { ppid: 1 }],
		[601, { ppid: 500 }],
		[700, { ppid: 1 }],
	]);
	const cgroups: Record<number, string> = {
		500: NON_SYSTEMD,
		501: NON_SYSTEMD,
		502: NON_SYSTEMD,
		600: NON_SYSTEMD,
		601: "/user.slice/user-1000.slice/user@1000.service/app.slice/wfc-test-501-1.scope",
		700: NON_SYSTEMD,
	};
	const claudePid: Record<number, string> = {
		501: "500",
		502: "500",
		600: "500",
		700: "900",
	};

	it("takes the leader, its descendants and the orphans whose environ names it", () => {
		expect(
			membersOf(
				procs,
				500,
				(p: number) => cgroups[p] ?? null,
				(p: number) => claudePid[p] ?? null,
			),
		).toEqual([500, 501, 502, 600]);
	});

	it("leaves a child already in a scope of its own, and another session's process", () => {
		const got = membersOf(
			procs,
			500,
			(p: number) => cgroups[p] ?? null,
			(p: number) => claudePid[p] ?? null,
		);
		expect(got).not.toContain(601);
		expect(got).not.toContain(700);
	});
});

/** Fake busctl, systemd-run and systemctl that log their argv, one call a line. */
function fakeBin({ refuse = "", active = false } = {}) {
	const bin = tmp("session-scope-bin-");
	const log = path.join(bin, "calls.log");
	const tool = (name: string, body: string) => {
		const file = path.join(bin, name);
		fs.writeFileSync(
			file,
			`#!/bin/sh\necho "${name} $(printf '%s ' "$@" | tr '\\n' ' ')" >> "${log}"\n${body}\n`,
		);
		fs.chmodSync(file, 0o755);
	};
	tool(
		"busctl",
		refuse
			? `case "$*" in *"${refuse}"*) echo "Call failed: No such process" >&2; exit 1;; esac`
			: "exit 0",
	);
	tool("systemd-run", "exit 0");
	tool(
		"systemctl",
		active ? "exit 0" : 'case "$*" in *is-active*) exit 3;; esac',
	);
	const calls = () =>
		fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
	return { bin, calls };
}

/** A fake /proc: leader 500 (a spare), its child 501, an orphan 600 whose
 * environ names 500, and 700 of another session. */
function fakeProc(leaderCgroup = NON_SYSTEMD) {
	const fake = makeProcRoot();
	cleanups.push(fake.remove);
	const put = (
		pid: number,
		spec: { ppid: number; argv: string; claudePid?: string },
	) => {
		fake.proc(pid, { ppid: spec.ppid, argv: [spec.argv] });
		fs.writeFileSync(
			path.join(fake.root, String(pid), "cgroup"),
			`0::${leaderCgroup}\n`,
		);
		fs.writeFileSync(
			path.join(fake.root, String(pid), "environ"),
			spec.claudePid
				? `PATH=/bin\0CLAUDE_PID=${spec.claudePid}\0`
				: "PATH=/bin\0",
		);
	};
	put(500, { ppid: 400, argv: SPARE });
	put(501, { ppid: 500, argv: "bash", claudePid: "500" });
	put(600, { ppid: 1, argv: "sleep", claudePid: "500" });
	put(700, { ppid: 1, argv: "sleep", claudePid: "900" });
	return fake;
}

function adopt(env: Record<string, string>, bin: string, procRoot: string) {
	/* This run's own session would otherwise be the leader read. */
	const { CLAUDE_PID: _, ...inherited } = process.env;
	return runInProcess(SCRIPT, [], {
		env: {
			...inherited,
			...env,
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			WFC_PROC: procRoot,
			CLAUDE_CONFIG_DIR: tmp("session-scope-config-"),
			CLAUDE_PROJECT_DIR: tmp("session-scope-project-"),
		},
	});
}

describe("adopt", () => {
	it("moves the leader alone, attaches the rest, then starts the watcher outside", () => {
		const { bin, calls } = fakeBin();
		const proc = fakeProc();
		const r = adopt({ CLAUDE_PID: "500" }, bin, proc.root);
		expect(r.stderr).toMatch(
			/session 500 in wfc-session-500-\d+\.scope, with 2 of its 2/,
		);
		const [start, attach, watch] = calls();
		expect(start).toMatch(
			/StartTransientUnit .* PIDs au 1 500 Slice s wfc-sessions\.slice/,
		);
		expect(attach).toMatch(
			/AttachProcessesToUnit ssau wfc-session-500-\d+\.scope {2}2 501 600 $/,
		);
		expect(watch).toMatch(
			/^systemd-run --user .*--expand-environment=no --unit=wfc-session-500-\d+-watch\.service/,
		);
		expect(watch).toMatch(/ sh 500 \d+ wfc-session-500-\d+\.scope ?$/);
	});

	it("retries a refused batch a pid at a time", () => {
		const { bin, calls } = fakeBin({ refuse: "2 501 600" });
		const proc = fakeProc();
		const r = adopt({ CLAUDE_PID: "500" }, bin, proc.root);
		expect(r.stderr).toMatch(/with 2 of its 2/);
		expect(
			calls().filter((c) => c.includes("AttachProcessesToUnit")),
		).toHaveLength(3);
	});

	it("starts nothing for a session already in its scope whose watcher runs", () => {
		const { bin, calls } = fakeBin({ active: true });
		const proc = fakeProc(SCOPED);
		const r = adopt({ CLAUDE_PID: "500" }, bin, proc.root);
		expect(r.stderr).toMatch(/already in/);
		expect(calls()).toEqual([
			expect.stringMatching(/^systemctl --user is-active/),
		]);
	});

	it("restarts the watcher of a scoped session whose watcher is gone", () => {
		const { bin, calls } = fakeBin();
		const proc = fakeProc(SCOPED);
		const r = adopt({ CLAUDE_PID: "500" }, bin, proc.root);
		expect(r.stderr).toMatch(/its watcher restarted/);
		expect(calls()[1]).toMatch(/^systemd-run /);
	});

	it.each([
		["no CLAUDE_PID", {}, /no CLAUDE_PID/],
		[
			"a CLAUDE_PID that is no Claude process",
			{ CLAUDE_PID: "501" },
			/no live Claude process/,
		],
	])("moves nothing and logs a fault for %s", (_, env, said) => {
		const { bin, calls } = fakeBin();
		const proc = fakeProc();
		const r = adopt(env, bin, proc.root);
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(said);
		expect(calls()).toEqual([]);
	});

	it("logs a fault where the user manager refuses the scope", () => {
		const { bin, calls } = fakeBin({ refuse: "StartTransientUnit" });
		const proc = fakeProc();
		const r = adopt({ CLAUDE_PID: "500" }, bin, proc.root);
		expect(r.stderr).toMatch(/no session scope: the user manager refused/);
		expect(calls()).toHaveLength(1);
	});
});

describe("the watcher", () => {
	/** A fake scope cgroup holding `procs`, and a systemctl that names it and
	 * empties it on `kill`. */
	function fakeScope(procs: string) {
		const root = tmp("session-scope-cg-");
		const dir = path.join(root, "scope");
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "cgroup.procs"), procs);
		fs.writeFileSync(path.join(dir, "cgroup.kill"), "");
		const bin = tmp("session-scope-wbin-");
		fs.writeFileSync(
			path.join(bin, "systemctl"),
			`#!/bin/sh\ncase "$*" in *show*) echo /scope;; *kill*) echo "$*" > "${root}/killed";; esac\n`,
		);
		fs.chmodSync(path.join(bin, "systemctl"), 0o755);
		const env = {
			...process.env,
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			WFC_CGROUP_ROOT: root,
		};
		return { root, dir, env };
	}

	const startOf = (pid: number) =>
		fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[19];

	it("reads a leader whose start time differs as ended, and kills what is left", () => {
		const { root, dir, env } = fakeScope("4242\n");
		const r = spawnSync(
			"sh",
			["-c", WATCH, "sh", String(process.pid), "0", "u.scope"],
			{
				encoding: "utf8",
				env,
				timeout: 20_000,
			},
		);
		expect(r.stdout).toMatch(
			/session \d+ ended; killing what is left in u\.scope: 4242/,
		);
		expect(fs.readFileSync(path.join(root, "killed"), "utf8")).toMatch(
			/--signal=SIGTERM u\.scope/,
		);
		expect(fs.readFileSync(path.join(dir, "cgroup.kill"), "utf8")).toBe("1\n");
	});

	it("waits while its leader lives, and does nothing to an empty scope", async () => {
		const { root, dir, env } = fakeScope("");
		const leader = spawn("sleep", ["30"]);
		cleanups.push(() => leader.kill("SIGKILL"));
		const pid = leader.pid as number;
		const watcher = spawn(
			"sh",
			["-c", WATCH, "sh", String(pid), startOf(pid), "u.scope"],
			{ env },
		);
		cleanups.push(() => watcher.kill("SIGKILL"));
		const exited = new Promise<number | null>((resolve) =>
			watcher.on("exit", resolve),
		);
		await new Promise((r) => setTimeout(r, 1000));
		expect(watcher.exitCode).toBeNull();
		leader.kill("SIGKILL");
		expect(await exited).toBe(0);
		expect(fs.existsSync(path.join(root, "killed"))).toBe(false);
		expect(fs.readFileSync(path.join(dir, "cgroup.kill"), "utf8")).toBe("");
	}, 20_000);
});
