import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { expect, onTestFinished, vi } from "vitest";
import { endedPid } from "./arbiter-testkit";
import { keptSpawn } from "./kept-spawn.js";
import { noop } from "./noop.js";
import { TEST_TIMEOUT_MS } from "./test-ceiling";

const YEAR_MS = 365 * 24 * 3_600_000;

// guess, #4721
const EXEC_WAIT_MS = TEST_TIMEOUT_MS / 2;
// guess, #4721
const EXEC_POLL_MS = 10;

// guess, #4721
const ORPHAN_POLL_MS = 1000;
const HOLDER_CODE = `const parent = process.ppid; setInterval(() => { if (process.ppid !== parent) process.exit(); }, ${ORPHAN_POLL_MS})`;

export function plantDeadLock(file: string) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, endedPid());
}

export async function liveScriptProcess(script: string) {
	const proc = keptSpawn("concurrent").spawn(
		process.execPath,
		["-e", HOLDER_CODE, script],
		{
			stdio: "ignore",
		},
	);
	onTestFinished(() => {
		proc.kill();
	});
	const pid = proc.pid as number;
	const died = once(proc, "exit").then(([code, signal]) => {
		throw new Error(`the holder exited before its exec (${code ?? signal})`);
	});
	died.catch(noop);
	await Promise.race([
		died,
		vi.waitFor(
			() => {
				if (proc.exitCode !== null || proc.signalCode !== null) return;
				expect(
					fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"),
				).toContain(script);
			},
			{ timeout: EXEC_WAIT_MS, interval: EXEC_POLL_MS },
		),
	]);
	return pid;
}

export async function plantLiveLock(file: string, script: string) {
	const pid = await liveScriptProcess(script);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, String(pid));
	const old = new Date(Date.now() - YEAR_MS);
	fs.utimesSync(file, old, old);
}
