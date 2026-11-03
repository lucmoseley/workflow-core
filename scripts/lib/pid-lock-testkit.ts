/*
 * pid-lock-testkit.ts — a pidfile lock planted for a test: one naming a process
 * that has ended, and one naming a live process running the marked script, with
 * an mtime long past any age test (#4016).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { onTestFinished } from "vitest";
import { endedPid } from "./arbiter-testkit";

const YEAR_MS = 365 * 24 * 3_600_000;

/** @param file the lock's path, its directory made where missing */
export function plantDeadLock(file: string) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, endedPid());
}

/**
 * A year-old lock held by a live process whose command line carries `script`,
 * killed when the test ends.
 */
export function plantLiveLock(file: string, script: string) {
	const holder = spawn(
		process.execPath,
		["-e", "setInterval(() => {}, 1000)", script],
		{ stdio: "ignore" },
	);
	onTestFinished(() => {
		holder.kill();
	});
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, String(holder.pid));
	const old = new Date(Date.now() - YEAR_MS);
	fs.utimesSync(file, old, old);
}
