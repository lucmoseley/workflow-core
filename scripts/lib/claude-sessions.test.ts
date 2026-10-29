// @vitest-environment node
/*
 * Pins lib/claude-sessions.sh and lib/claude-sessions.js, the shell and Node
 * twins of lib/claude_sessions.py, by one case list run against both: one
 * session per Claude `bg-pty-host`, less the daemon's unclaimed spare (#1798).
 * The spare's cwd is a lib/proc-fake.ts `cwd` link pointing at its claim
 * socket's directory, as the daemon leaves one, which both twins read through
 * WFC_PROC (#3608) — the Node twin through its production adapter,
 * readProcCwd. One shell case reads the kernel's own link off a live
 * process, since proc.contract.test.ts holds only the Node reader to the
 * kernel. sparePairs, which has no shell twin, runs its own cases below on a
 * stub cwd reader.
 *
 * Break it and record-divergence.js's `sessions` column and the shell-start
 * warning read one high for as long as the daemon runs.
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeCwd } from "./proc-fake";

const LIB = path.resolve(__dirname, "claude-sessions.sh");

let dir: string;
let proc: string;
let spareDir: string;

beforeAll(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-sessions-"));
	proc = path.join(dir, "proc");
	spareDir = path.join(dir, "spare");
	fs.mkdirSync(spareDir);
	writeCwd(proc, "31", spareDir);
	writeCwd(proc, "32", spareDir);
	writeCwd(proc, "33", dir);
});

afterAll(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const { countSessions, readProcCwd, sparePairs } =
	require("./claude-sessions.js") as {
		countSessions: (
			ps: string,
			cwdOf: (pid: string) => string | null,
		) => number;
		readProcCwd: (pid: string, proc: string) => string | null;
		sparePairs: (
			procs: { pid: string; args: string }[],
			cwdOf: (pid: string) => string | null,
		) => { socket: string; pids: string[]; idle: boolean }[];
	};

function countSh(rows: string[], column?: number, root = proc): string {
	return execFileSync(
		"bash",
		["-c", `source "$1"; wfc_session_count ${column ?? ""}`, "_", LIB],
		{
			input: `${rows.join("\n")}\n`,
			encoding: "utf8",
			env: { ...process.env, WFC_PROC: root },
		},
	).trim();
}

const countJs = (rows: string[]): string =>
	String(
		countSessions(`${rows.join("\n")}\n`, (pid) => readProcCwd(pid, proc)),
	);

const host = (pid: number, sock: string) =>
	`${pid} 1 claude bg-pty-host --bg-pty-host ${spareDir}/${sock}.pty.sock 200 50`;
const child = (pid: number, ppid: number, sock: string) =>
	`${pid} ${ppid} claude bg-spare --bg-spare ${spareDir}/${sock}.claim.sock`;

describe.each([
	["wfc_session_count", countSh],
	["countSessions", countJs],
])("%s", (_name, count) => {
	it("leaves out a host whose bg-spare still sits in its claim socket's directory (#1798)", () => {
		// 999_999 has no cwd link, so this child reads as claimed.
		const rows = [host(10, "a"), child(999_999, 10, "a")];
		rows.push(host(20, "b"), child(31, 20, "b"));
		expect(count(rows)).toBe("1");
	});

	it("takes one host off at most, however many unclaimed spares it lists", () => {
		const rows = [host(10, "a"), host(20, "b")];
		rows.push(child(31, 10, "a"), child(32, 10, "a"));
		expect(count(rows)).toBe("1");
	});

	it("counts a host whose bg-spare runs in another directory, as a claimed one does", () => {
		expect(count([host(10, "a"), child(33, 10, "a")])).toBe("1");
	});

	it("subtracts nothing for a spare whose parent is no host", () => {
		expect(count([host(10, "a"), child(31, 1, "b")])).toBe("1");
	});

	it("counts every Claude argv[0] shape and nothing else", () => {
		expect(
			count([
				"1 0 /home/u/.local/share/claude/versions/2.1.234 bg-pty-host --job a",
				"2 0 C:\\Users\\u\\claude.exe bg-pty-host --job b",
				"3 0 claude agents --json",
				"4 0 /bin/bash -c ps -eo args= | grep bg-pty-host",
			]),
		).toBe("2");
	});

	it("prints 0 on no input", () => {
		expect(count([])).toBe("0");
	});
});

// The shell twin's caller passes a column; the Node twin reads `ps -eo
// pid=,ppid=,args=` alone.
describe("wfc_session_count", () => {
	it("reads argv from the column it is told, past an rss column", () => {
		expect(countSh(["10 1 524288 claude bg-pty-host --job x"], 4)).toBe("1");
	});

	it.skipIf(!fs.existsSync("/proc/self/cwd"))(
		"compares a live spare's kernel cwd link by inode",
		() => {
			// The spare directory's realpath, as the daemon's cwd would read.
			const real = fs.realpathSync(spareDir);
			// 60 s only has to outlive this case; the finally kills it sooner.
			const sleeper = spawn("sleep", ["60"], { cwd: real, stdio: "ignore" });
			try {
				const pid = sleeper.pid as number;
				expect(countSh([host(10, "a"), child(pid, 10, "a")], 3, "")).toBe("0");
			} finally {
				sleeper.kill("SIGKILL");
			}
		},
	);
});

describe("sparePairs", () => {
	const sp = "/tmp/d/spare";
	const cwds: Record<string, string> = { "11": sp, "21": "/home/u/repo" };
	const read = (pid: string) => cwds[pid] ?? null;
	const pair = (pid: number, id: string) => [
		{
			pid: String(pid),
			args: `claude bg-pty-host --bg-pty-host ${sp}/${id}.pty.sock`,
		},
		{
			pid: String(pid + 1),
			args: `claude bg-spare --bg-spare ${sp}/${id}.claim.sock`,
		},
	];
	const idleOf = (procs: { pid: string; args: string }[]) =>
		Object.fromEntries(sparePairs(procs, read).map((p) => [p.socket, p.idle]));

	it("reads a pair idle only while its bg-spare sits in its claim socket's directory", () => {
		expect(idleOf([...pair(10, "a"), ...pair(20, "b")])).toEqual({
			a: true,
			b: false,
		});
	});

	it("reads a pair claimed where its cwd will not read, or it has no bg-spare half", () => {
		expect(idleOf([...pair(30, "c"), pair(10, "d")[0]])).toEqual({
			c: false,
			d: false,
		});
	});

	it("groups both halves under one socket id and skips any argv[0] not Claude's", () => {
		const pairs = sparePairs(
			[...pair(10, "a"), { pid: "99", args: `awk ${sp}/a.claim.sock` }],
			read,
		);
		expect(pairs.map((p) => p.pids)).toEqual([["10", "11"]]);
	});
});
