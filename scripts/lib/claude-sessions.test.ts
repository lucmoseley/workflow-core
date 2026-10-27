// @vitest-environment node
/*
 * Pins lib/claude-sessions.sh and lib/claude-sessions.js, the shell and Node
 * twins of lib/claude_sessions.py, by one case list run against both: one
 * session per Claude `bg-pty-host`, less the daemon's unclaimed spare (#1798).
 * The spare is a real sleeping process whose cwd is its claim socket's
 * directory, as the daemon leaves one, since both read /proc — the Node twin
 * through its production adapter, isProcCwd.
 *
 * Break it and record-divergence.js's `sessions` column and the shell-start
 * warning read one high for as long as the daemon runs.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const LIB = path.resolve(__dirname, "claude-sessions.sh");
const hasProc = fs.existsSync("/proc/self/cwd");

let dir: string;
let spareDir: string;
let sleeper: ChildProcess;
let sleeper2: ChildProcess;

beforeAll(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-sessions-"));
	spareDir = path.join(dir, "spare");
	fs.mkdirSync(spareDir);
	// 60 s only has to outlive this file's tests; afterAll kills it sooner.
	sleeper = spawn("sleep", ["60"], { cwd: spareDir, stdio: "ignore" });
	sleeper2 = spawn("sleep", ["60"], { cwd: spareDir, stdio: "ignore" });
});

afterAll(() => {
	sleeper.kill("SIGKILL");
	sleeper2.kill("SIGKILL");
	fs.rmSync(dir, { recursive: true, force: true });
});

const { countSessions, isProcCwd } = require("./claude-sessions.js") as {
	countSessions: (
		ps: string,
		isCwd: (pid: string, dir: string) => boolean,
	) => number;
	isProcCwd: (pid: string, dir: string) => boolean;
};

function countSh(rows: string[], column?: number): string {
	return execFileSync(
		"bash",
		["-c", `source "$1"; wfc_session_count ${column ?? ""}`, "_", LIB],
		{ input: `${rows.join("\n")}\n`, encoding: "utf8" },
	).trim();
}

const countJs = (rows: string[]): string =>
	String(countSessions(`${rows.join("\n")}\n`, isProcCwd));

const host = (pid: number, sock: string) =>
	`${pid} 1 claude bg-pty-host --bg-pty-host ${spareDir}/${sock}.pty.sock 200 50`;
const child = (pid: number, ppid: number, sock: string) =>
	`${pid} ${ppid} claude bg-spare --bg-spare ${spareDir}/${sock}.claim.sock`;

describe.skipIf(!hasProc).each([
	["wfc_session_count", countSh],
	["countSessions", countJs],
])("%s", (_name, count) => {
	it("leaves out a host whose bg-spare still sits in its claim socket's directory (#1798)", () => {
		const pid = sleeper.pid as number;
		// Whatever runs at 999_999, if anything, is not in the spare directory, so
		// this child reads as claimed.
		const rows = [host(10, "a"), child(999_999, 10, "a")];
		rows.push(host(20, "b"), child(pid, 20, "b"));
		expect(count(rows)).toBe("1");
	});

	it("takes one host off at most, however many unclaimed spares it lists", () => {
		const rows = [host(10, "a"), host(20, "b")];
		rows.push(child(sleeper.pid as number, 10, "a"));
		rows.push(child(sleeper2.pid as number, 10, "a"));
		expect(count(rows)).toBe("1");
	});

	it("counts a host whose bg-spare runs in another directory, as a claimed one does", () => {
		// This test's own process is live and sits outside the spare directory.
		expect(count([host(10, "a"), child(process.pid, 10, "a")])).toBe("1");
	});

	it("subtracts nothing for a spare whose parent is no host", () => {
		const pid = sleeper.pid as number;
		expect(count([host(10, "a"), child(pid, 1, "b")])).toBe("1");
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
});
