/*
 * pid-lock-testkit.ts — a pidfile lock planted for a test: one naming a process
 * that has ended, and one naming a live process running the marked script, with
 * an mtime long past any age test (#4016); and that live process on its own,
 * for a test that writes the pidfile itself.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { expect, onTestFinished, vi } from "vitest";
import { endedPid } from "./arbiter-testkit";
import { TEST_TIMEOUT_MS } from "./test-ceiling";

const YEAR_MS = 365 * 24 * 3_600_000;

/* The wait for a holder's exec: far above the milliseconds it takes unloaded,
 * and under TEST_TIMEOUT_MS, so a stuck exec fails naming this wait rather than
 * the case. Half the ceiling is a round pick; no measurement gives it. */
const EXEC_WAIT_MS = TEST_TIMEOUT_MS / 2;
/* A guess, unmeasured: fine enough to add little to a fast exec. */
const EXEC_POLL_MS = 10;

/* The holder's program: it idles, and exits once its parent is gone, so a
 * worker killed before its cleanup leaves no holder behind. */
const HOLDER_CODE =
	"const parent = process.ppid; setInterval(() => { if (process.ppid !== parent) process.exit(); }, 1000)";

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
	const proc = spawn(process.execPath, ["-e", HOLDER_CODE, script], {
		stdio: "ignore",
	});
	onTestFinished(() => {
		proc.kill();
	});
	const pid = proc.pid as number;
	/* A holder that dies or never starts fails here, not as the wait's timeout. */
	const died = once(proc, "exit").then(([code, signal]) => {
		throw new Error(`the holder exited before its exec (${code ?? signal})`);
	});
	died.catch(() => {
		/* its kill at the test's end is no failure */
	});
	await Promise.race([
		died,
		vi.waitFor(
			() =>
				expect(
					fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"),
				).toContain(script),
			{ timeout: EXEC_WAIT_MS, interval: EXEC_POLL_MS },
		),
	]);
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
