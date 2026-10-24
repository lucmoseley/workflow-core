// @vitest-environment node
/*
 * Pins lib/claude-sessions.sh, the shell twin of lib/claude_sessions.py: one
 * session per Claude `bg-pty-host`, less the daemon's unclaimed spare (#1798).
 * The spare is a real sleeping process whose cwd is its claim socket's
 * directory, as the daemon leaves one, since the function reads /proc.
 *
 * Break it and record-divergence.sh's `sessions` column and the shell-start
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

beforeAll(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-sessions-"));
	spareDir = path.join(dir, "spare");
	fs.mkdirSync(spareDir);
	// 60 s only has to outlive this file's tests; afterAll kills it sooner.
	sleeper = spawn("sleep", ["60"], { cwd: spareDir, stdio: "ignore" });
});

afterAll(() => {
	sleeper.kill("SIGKILL");
	fs.rmSync(dir, { recursive: true, force: true });
});

function count(rows: string[], column?: number): string {
	return execFileSync(
		"bash",
		["-c", `source "$1"; wfc_session_count ${column ?? ""}`, "_", LIB],
		{ input: `${rows.join("\n")}\n`, encoding: "utf8" },
	).trim();
}

const host = (pid: number, sock: string) =>
	`${pid} 1 claude bg-pty-host --bg-pty-host ${spareDir}/${sock}.pty.sock 200 50`;
const child = (pid: number, ppid: number, sock: string) =>
	`${pid} ${ppid} claude bg-spare --bg-spare ${spareDir}/${sock}.claim.sock`;

describe.skipIf(!hasProc)("wfc_session_count", () => {
	it("leaves out a host whose bg-spare still sits in its claim socket's directory (#1798)", () => {
		const pid = sleeper.pid as number;
		// Whatever runs at 999_999, if anything, is not in the spare directory, so
		// this child reads as claimed.
		const rows = [host(10, "a"), child(999_999, 10, "a")];
		rows.push(host(20, "b"), child(pid, 20, "b"));
		expect(count(rows)).toBe("1");
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

	it("reads argv from the column it is told, past an rss column", () => {
		expect(count(["10 1 524288 claude bg-pty-host --job x"], 4)).toBe("1");
	});

	it("prints 0 on no input", () => {
		expect(count([])).toBe("0");
	});
});
