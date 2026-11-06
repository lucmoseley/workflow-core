// @vitest-environment node
/*
 * session-scope.js (#4341), run in process against a fake /proc, its
 * systemd tools stubs at WFC_BUSCTL and WFC_SYSTEMD_RUN and
 * lib/systemctl-fake.ts at WFC_SYSTEMCTL, each logging its calls, so no test
 * moves a real process.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeProcRoot } from "./lib/proc-fake";
import { runInProcess } from "./lib/run-in-process.js";
import { writeSystemctl } from "./lib/systemctl-fake";

const SCRIPT = path.join(__dirname, "session-scope.js");
const NON_SYSTEMD = "/non-systemd";
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

/** Stubs that log their argv, one call a line; `refuse` fails a busctl call
 * whose words hold it, `active` answers `is-active` yes. An attach moves its
 * pids out of `/non-systemd` in the fake /proc, as the manager would. */
function fakeTools(procRoot: string, { refuse = "", active = false } = {}) {
	const dir = tmp("session-scope-bin-");
	const log = path.join(dir, "calls");
	const tool = (name: string, body: string) => {
		const file = path.join(dir, name);
		fs.writeFileSync(
			file,
			`#!/bin/sh\necho "${name} $(printf '%s ' "$@" | tr '\\n' ' ')" >> "${log}"\n${body}\n`,
		);
		fs.chmodSync(file, 0o755);
		return file;
	};
	const env = {
		WFC_BUSCTL: tool(
			"busctl",
			`${refuse ? `case "$*" in *"${refuse}"*) echo "Call failed: No such process" >&2; exit 1;; esac` : ""}
case "$1 $6 $7" in "--user AttachProcessesToUnit ssau")
  shift 10; for q in "$@"; do echo "0::/scoped" > "${procRoot}/$q/cgroup"; done;;
esac`,
		),
		WFC_SYSTEMD_RUN: tool("systemd-run", "exit 0"),
		WFC_SYSTEMCTL: writeSystemctl(dir, {
			units: {
				"wfc-session-500-19640000-watch.service": {
					active: active ? "active" : "inactive",
				},
			},
		}),
	};
	const calls = () =>
		fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
	return { env, calls };
}

/** A fake /proc: leader 500 (a spare) in `leaderCgroup`, its child 501, an
 * orphan 600 whose environ names 500, and 700 of another session. */
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

function adopt(
	env: Record<string, string>,
	tools: Record<string, string>,
	procRoot: string,
) {
	/* This run's own session would otherwise be the leader read. */
	const { CLAUDE_PID: _, ...inherited } = process.env;
	return runInProcess(SCRIPT, [], {
		env: {
			...inherited,
			...env,
			...tools,
			WFC_PROC: procRoot,
			CLAUDE_CONFIG_DIR: tmp("session-scope-config-"),
			CLAUDE_PROJECT_DIR: tmp("session-scope-project-"),
		},
	});
}

describe("session-scope.js", () => {
	it("moves the leader alone, attaches the rest, then starts the watcher outside", () => {
		const proc = fakeProc();
		const { env, calls } = fakeTools(proc.root);
		const r = adopt({ CLAUDE_PID: "500" }, env, proc.root);
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(
			/session 500 in wfc-session-500-\d+\.scope, with 2 other process/,
		);
		const [start, attach, ...rest] = calls();
		expect(start).toMatch(
			/StartTransientUnit .* PIDs au 1 500 Slice s wfc-sessions\.slice/,
		);
		expect(attach).toMatch(
			/AttachProcessesToUnit ssau wfc-session-500-\d+\.scope {2}2 501 600 $/,
		);
		const watch = rest.at(-1);
		expect(watch).toMatch(
			/^systemd-run --user .*--expand-environment=no --unit=wfc-session-500-\d+-watch\.service/,
		);
		expect(watch).toMatch(/ sh 500 \d+ wfc-session-500-\d+\.scope ?$/);
	});

	it("moves a session born in another session's scope into one of its own", () => {
		const proc = fakeProc(
			"/user.slice/user-1000.slice/user@1000.service/wfc.slice/wfc-sessions.slice/wfc-session-321-9.scope",
		);
		const { env, calls } = fakeTools(proc.root, { active: true });
		const r = adopt({ CLAUDE_PID: "500" }, env, proc.root);
		expect(r.status).toBe(0);
		expect(calls()[0]).toMatch(/StartTransientUnit .* PIDs au 1 500 /);
	});

	it("starts nothing for a session already in its own scope whose watcher runs", () => {
		const proc = fakeProc(
			"/user.slice/user-1000.slice/user@1000.service/wfc.slice/wfc-sessions.slice/wfc-session-500-19640000.scope",
		);
		const { env, calls } = fakeTools(proc.root, { active: true });
		const r = adopt({ CLAUDE_PID: "500" }, env, proc.root);
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(/already in/);
		expect(calls()).toEqual([
			expect.stringMatching(/^systemctl --user is-active/),
		]);
	});

	it("restarts the watcher of a scoped session whose watcher is gone", () => {
		const proc = fakeProc(
			"/user.slice/user-1000.slice/user@1000.service/wfc.slice/wfc-sessions.slice/wfc-session-500-19640000.scope",
		);
		const { env, calls } = fakeTools(proc.root);
		const r = adopt({ CLAUDE_PID: "500" }, env, proc.root);
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(/its watcher restarted/);
		expect(calls()[1]).toMatch(/^systemd-run /);
	});

	it.each([
		["no CLAUDE_PID", {}, /no CLAUDE_PID: this session runs uncontained/],
		[
			"a CLAUDE_PID that is no Claude process",
			{ CLAUDE_PID: "501" },
			/no live Claude process: this session runs uncontained/,
		],
	])("moves nothing and says so for %s", (_, given, said) => {
		const proc = fakeProc();
		const { env, calls } = fakeTools(proc.root);
		const r = adopt(given, env, proc.root);
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(said);
		expect(calls()).toEqual([]);
	});

	it("says so where the user manager refuses the scope", () => {
		const proc = fakeProc();
		const { env, calls } = fakeTools(proc.root, {
			refuse: "StartTransientUnit",
		});
		const r = adopt({ CLAUDE_PID: "500" }, env, proc.root);
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(
			/the user manager refused .*this session runs uncontained/,
		);
		expect(calls()).toHaveLength(1);
	});
});
