// @vitest-environment node
/*
 * Pins the budgeted group runner check-gates.js spends its budget through
 * (#2855, #2928): past the budget the whole group dies, a TERM-trapping grandchild
 * included, and every other end reaches the caller as it happened. Loosen a
 * case and the sweep waits out a check that ignores its TERM.
 *
 * Every case crosses the real clock: what is pinned is a real kill of real
 * processes, which no injected clock reaches.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isGroupDead } from "./process-fixture";
import { runInProcessAsync } from "./run-in-process.js";

const {
	RUN_BUDGETED,
	TIMEOUT_EXIT,
	KILLED_EXIT,
	APPARATUS_EXIT,
	APPARATUS_PREFIX,
} = require("./run-budgeted.js");

/* Short, so the file stays inside its budget; the commands under test sleep
 * for 30 s, so a survivor is far past any of these. */
const BUDGET_MS = 500;
const KILL_AFTER_MS = 500;

/* A SIGKILLed member still runs until it is next scheduled, so a busy machine
 * gets a moment; a survivor sleeps far past it. The 2 s is a first guess,
 * unmeasured. */
async function expectGroupDead(pgid: number) {
	await vi.waitFor(() => expect(isGroupDead(pgid)).toBe(true), {
		timeout: 2000,
	});
}

function runSh(script: string) {
	const started = Date.now();
	// spawn-kept: a timeout and a signal — the budget kills a real process group
	const r = spawnSync(
		process.execPath,
		[
			RUN_BUDGETED,
			String(BUDGET_MS),
			String(KILL_AFTER_MS),
			"sh",
			"-c",
			script,
		],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	return { ...r, elapsedMs: Date.now() - started };
}

describe("past the budget", () => {
	it("kills a TERM-trapping grandchild and exits 137, the #2855 case", async () => {
		const r = runSh("echo $$; trap '' TERM; sleep 30 & wait");
		expect(r.status).toBe(KILLED_EXIT);
		expect(r.elapsedMs).toBeLessThan(SECOND_SIGNAL_BOUND_MS);
		await expectGroupDead(Number(r.stdout.trim()));
	});

	it("exits 124 where the TERM ended the leader, killing a straggler that outlived it", async () => {
		const r = runSh("echo $$; (trap '' TERM; sleep 30) & sleep 30");
		expect(r.status).toBe(TIMEOUT_EXIT);
		expect(r.elapsedMs).toBeLessThan(SECOND_SIGNAL_BOUND_MS);
		await expectGroupDead(Number(r.stdout.trim()));
	});
});

describe("inside the budget", () => {
	it("passes the command's own status through", () => {
		expect(runSh("exit 3").status).toBe(3);
	});

	it.each(["SIGTERM", "SIGPIPE"])(
		"ends by %s where that signal ended the command, node's own handling of it notwithstanding",
		(signal) => {
			const r = runSh(`kill -${signal.slice(3)} $$`);
			expect(r.status).toBeNull();
			expect(r.signal).toBe(signal);
		},
	);
});

describe("its own failures", () => {
	it("exits 125 with its prefix where the command would not start", async () => {
		const r = await runInProcessAsync(RUN_BUDGETED, [
			"1000",
			"1000",
			"no-such-command-2855",
		]);
		expect(r.status).toBe(APPARATUS_EXIT);
		expect(r.stderr).toMatch(new RegExp(`^${APPARATUS_PREFIX}.*ENOENT`));
	});

	it("exits 125 with its prefix on a usage error", async () => {
		const r = await runInProcessAsync(RUN_BUDGETED, ["soon", "1000", "true"]);
		expect(r.status).toBe(APPARATUS_EXIT);
		expect(r.stderr.startsWith(APPARATUS_PREFIX)).toBe(true);
	});
});

/* The signal lands just after the command starts, the #2928 window. A runner
 * that arms its handlers late fails this only some runs: 3 in 10 under a
 * whole suite's load, 0 in 10 idle. */
it("kills a group that ignores the signal, and dies by it, when told to stop (#2928)", async () => {
	// spawn-kept: a signal, sent to the runner mid-run
	const child = spawn(
		process.execPath,
		[
			RUN_BUDGETED,
			"60000",
			"1000",
			"sh",
			"-c",
			"echo $$; trap '' TERM; sleep 30 & wait",
		],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);
	const pgid = await new Promise<number>((resolve) =>
		child.stdout.once("data", (d) => resolve(Number(String(d).trim()))),
	);
	const ended = new Promise<NodeJS.Signals | null>((resolve) =>
		child.on("exit", (_code, signal) => resolve(signal)),
	);
	child.kill("SIGTERM");
	expect(await ended).toBe("SIGTERM");
	await expectGroupDead(pgid);
});

/* A signalled run's budget and grace: the budget far past the case, so only
 * the signal ends it; the grace long enough that a run ending inside
 * SECOND_SIGNAL_BOUND_MS, half of it, ended on the second signal rather
 * than waiting the grace out. */
const SIGNALLED_BUDGET_MS = 60_000;
const SIGNALLED_GRACE_MS = 20_000;
const SECOND_SIGNAL_BOUND_MS = SIGNALLED_GRACE_MS / 2;
/* Between two sends, so the runner's listener has run on the first before
 * the second arrives; a first guess, unmeasured. */
const SIGNAL_GAP_MS = 200;

/** The runner over `script`, signalled once the script echoes its pid. */
async function signalled(script: string, signals: NodeJS.Signals[]) {
	// spawn-kept: a signal, sent to the runner mid-run
	const child = spawn(
		process.execPath,
		[
			RUN_BUDGETED,
			String(SIGNALLED_BUDGET_MS),
			String(SIGNALLED_GRACE_MS),
			"sh",
			"-c",
			`echo $$; ${script}`,
		],
		{ stdio: ["ignore", "pipe", "ignore"] },
	);
	const pgid = await new Promise<number>((resolve) =>
		child.stdout.once("data", (d) => resolve(Number(String(d).trim()))),
	);
	const started = Date.now();
	const ended = new Promise<NodeJS.Signals | null>((resolve) =>
		child.on("exit", (_code, signal) => resolve(signal)),
	);
	/* Spaced apart: a standard signal does not queue, so two sent at once
	 * reach the runner as one. */
	for (const signal of signals) {
		child.kill(signal);
		await new Promise((resolve) => setTimeout(resolve, SIGNAL_GAP_MS));
	}
	return { pgid, signal: await ended, elapsedMs: Date.now() - started };
}

describe("a signal to the runner (#5188)", () => {
	it("passes it on to the group, so a member's cleanup runs, and dies by it", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-budgeted-"));
		const mark = path.join(dir, "cleaned");
		try {
			const r = await signalled(
				`trap 'touch ${mark}; exit 130' INT; sleep 30 & wait`,
				["SIGINT"],
			);
			expect(r.signal).toBe("SIGINT");
			expect(fs.existsSync(mark)).toBe(true);
			await expectGroupDead(r.pgid);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("kills the group at once on a second signal, not after kill-after-ms", async () => {
		const r = await signalled("trap '' TERM; sleep 30 & wait", [
			"SIGTERM",
			"SIGTERM",
		]);
		expect(r.signal).toBe("SIGTERM");
		expect(r.elapsedMs).toBeLessThan(SECOND_SIGNAL_BOUND_MS);
		await expectGroupDead(r.pgid);
	});
});
