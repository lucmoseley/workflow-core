/*
 * pid-lock-testkit.ts — a pidfile lock planted for a test: one naming a process
 * that has ended, and one naming a live process running the marked script, with
 * an mtime long past any age test (#4016).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, onTestFinished, vi } from "vitest";
import { endedPid } from "./arbiter-testkit";
import { TEST_TIMEOUT_MS } from "./test-ceiling";

const YEAR_MS = 365 * 24 * 3_600_000;

/** @param file the lock's path, its directory made where missing */
export function plantDeadLock(file: string) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, endedPid());
}

/**
 * The pid of a live process whose command line carries `script`, killed when
 * the test ends. Its pid is live before its exec lands, and until then that
 * command line reads empty, so a lock asked at once finds no holder (#4721):
 * it is returned once `script` is there.
 */
export async function liveScriptProcess(script: string) {
	// spawn-kept: two processes at once — a live holder whose command line the lock reads.
	const proc = spawn(
		process.execPath,
		["-e", "setInterval(() => {}, 1000)", script],
		{ stdio: "ignore" },
	);
	onTestFinished(() => {
		proc.kill();
	});
	const pid = proc.pid as number;
	await vi.waitFor(
		() =>
			expect(
				fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"),
			).toContain(script),
		{ timeout: TEST_TIMEOUT_MS, interval: 10 },
	);
	return pid;
}

/** A year-old lock held by a live process whose command line carries `script`. */
export async function plantLiveLock(file: string, script: string) {
	const pid = await liveScriptProcess(script);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, String(pid));
	const old = new Date(Date.now() - YEAR_MS);
	fs.utimesSync(file, old, old);
}
