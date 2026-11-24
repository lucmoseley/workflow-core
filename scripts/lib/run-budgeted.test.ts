// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { keptSpawn } from "./kept-spawn.js";
import { isGroupDead } from "./process-fixture";
import { runInProcessAsync } from "./run-in-process.js";

const {
	RUN_BUDGETED,
	TIMEOUT_EXIT,
	KILLED_EXIT,
	APPARATUS_EXIT,
	APPARATUS_PREFIX,
} = require("./run-budgeted.js");

// guess, #2855
const BUDGET_MS = 500;
const KILL_AFTER_MS = 500;

async function expectGroupDead(pgid: number) {
	await vi.waitFor(() => expect(isGroupDead(pgid)).toBe(true), {
		// guess, #2928
		timeout: 2000,
	});
}

function runSh(script: string, budgetMs = BUDGET_MS) {
	const started = Date.now();
	const r = keptSpawn("timeout").spawnSync(
		process.execPath,
		[RUN_BUDGETED, String(budgetMs), String(KILL_AFTER_MS), "sh", "-c", script],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	return { ...r, elapsedMs: Date.now() - started };
}

// guess, #5736
const BUDGET_DOUBLINGS = 3;
const TRAPPED = "trapped";

// #5736
function runShUntilTrapped(script: string) {
	let budgetMs = BUDGET_MS;
	for (let doublings = 0; ; doublings++) {
		const r = runSh(script, budgetMs);
		const [pgid, ready] = r.stdout.trim().split("\n");
		if (ready === TRAPPED) return { ...r, pgid: Number(pgid) };
		if (r.status !== TIMEOUT_EXIT || doublings === BUDGET_DOUBLINGS)
			throw new Error(
				`sh never printed ${TRAPPED} inside a ${budgetMs} ms budget, so the case went untested: exit ${r.status}, stderr ${JSON.stringify(r.stderr)}`,
			);
		budgetMs *= 2;
	}
}

describe("past the budget", () => {
	it("kills a TERM-trapping grandchild and exits 137, the #2855 case", async () => {
		const r = runShUntilTrapped(
			`echo $$; trap '' TERM; echo ${TRAPPED}; sleep 30 & wait`,
		);
		expect(r.status).toBe(KILLED_EXIT);
		expect(r.elapsedMs).toBeLessThan(SECOND_SIGNAL_BOUND_MS);
		await expectGroupDead(r.pgid);
	});

	it("exits 124 where the TERM ended the leader, killing a straggler that outlived it", async () => {
		const r = runShUntilTrapped(
			`echo $$; (trap '' TERM; echo ${TRAPPED}; sleep 30) & sleep 30`,
		);
		expect(r.status).toBe(TIMEOUT_EXIT);
		expect(r.elapsedMs).toBeLessThan(SECOND_SIGNAL_BOUND_MS);
		await expectGroupDead(r.pgid);
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

it("kills a group that ignores the signal, and dies by it, when told to stop (#2928)", async () => {
	const child = keptSpawn("signal").spawn(
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

// guess, #5188
const SIGNALLED_BUDGET_MS = 60_000;
const SIGNALLED_GRACE_MS = 20_000;
const SECOND_SIGNAL_BOUND_MS = SIGNALLED_GRACE_MS / 2;
// guess, #5188
const SIGNAL_GAP_MS = 200;

async function signalled(script: string, signals: NodeJS.Signals[]) {
	const child = keptSpawn("signal").spawn(
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
