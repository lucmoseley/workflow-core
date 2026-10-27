/*
 * bg-run-testkit.ts — the fixture both scripts/bg-run.sh suites stand on: a
 * throwaway WFC_BG_ROOT per case, the env that points every log into it, and
 * the event waits that read a run's files.
 *
 * Break it and both suites fail at once, or write into the real repo's
 * durable kill and launch logs.
 */

import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect } from "vitest";
import { isDead } from "./process-fixture";

const { TEST_TIMEOUT_MS } = require("./test-ceiling.js");

export const SCRIPT = join(__dirname, "..", "bg-run.sh");

/* Fast beats so the kill arms do not spend twenty seconds each waiting for the
 * default staleness window to open. */
export const FAST = {
	WFC_BG_HEARTBEAT_S: "1",
	WFC_BG_STALE_S: "2",
	WFC_BG_WAIT_POLL_S: "1",
	/* Short enough that the "never launched" tests below don't pay the full
	 * 2s default retry. The fabricated-directory race tests set their own,
	 * WIDE_MISSING. */
	WFC_BG_MISSING_S: "1.5",
	WFC_BG_MISSING_POLL_S: "0.1",
};

/* Three of FAST's heartbeats: three watcher passes, any of which would kill a
 * run it read as due. */
export const THREE_BEATS_S = 3 * Number(FAST.WFC_BG_HEARTBEAT_S);

/* How long a command a case kills runs if left alone (#2689): past the case's
 * own timeout, so no stall the case survives carries its kill past the
 * command's end. The 30 s beyond it is a guess, for a timeout a stalled
 * event loop fires late. A wrapper-alone kill orphans the command, which
 * afterEach ends rather than leaving it to run out. */
export const KILLED_LIFETIME_S = String(TEST_TIMEOUT_MS / 1000 + 30);

/* Every process launched with WFC_BG_ROOT exactly `dir`, as env() sets it:
 * wrappers, watchers and orphaned commands all inherit it. Any other process
 * a case starts owes its own kill. */
export function readProcessesUnder(dir: string) {
	const mark = `WFC_BG_ROOT=${dir}`;
	return readdirSync("/proc").filter((pid) => {
		if (!/^\d+$/.test(pid)) return false;
		try {
			return readFileSync(`/proc/${pid}/environ`, "utf8")
				.split("\0")
				.includes(mark);
		} catch {
			return false; // exited between the listing and the read
		}
	});
}

export function env(extra: Record<string, string> = {}) {
	return {
		...process.env,
		WFC_BG_ROOT: root,
		/* Keeps kills.jsonl at the same fixture path the tests already assert
		 * against — without this override record_kill() would ask git for the
		 * real repo's common dir (mantahostels#2691) and write into the shared, durable
		 * log this test run does not own. */
		WFC_BG_KILL_LOG: join(root, "kills.jsonl"),
		/* Same reason, for the launch log (mantahostels#2763): every `run` in this file
		 * appends one, so without the override the suite would write into the
		 * real repo's durable denominator. */
		WFC_BG_LAUNCH_LOG: join(root, "launches.jsonl"),
		WFC_BG_POLL_LOG: join(root, "polls.log"),
		...FAST,
		...extra,
	};
}

/* Every synchronous spawn in this file is bounded (#2675): a hung wrapper
 * blocks the worker's event loop, so no vitest timeout can fire, and the
 * worker outlives its run. 60 s is a guess, three CEILING_MS waits and under
 * the 90 s TEST_TIMEOUT_MS. KILL, because the wrapper traps TERM. */
export const BOUNDED = { timeout: 60_000, killSignal: "SIGKILL" } as const;

export function run(args: string[], extra: Record<string, string> = {}) {
	return spawnSync(SCRIPT, args, {
		env: env(extra),
		encoding: "utf8",
		...BOUNDED,
	});
}

export function check(name: string, extra: Record<string, string> = {}) {
	return run(["check", name], extra);
}

/* `run` above can only ADD to the environment, and several of the launch-log
 * tests (mantahostels#2763) turn on a variable being ABSENT. */
export function runWithout(drop: string[], args: string[]) {
	const clean: NodeJS.ProcessEnv = { ...env() };
	for (const key of drop) delete clean[key];
	return spawnSync(SCRIPT, args, { env: clean, encoding: "utf8", ...BOUNDED });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function readJsonLines(path: string) {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l));
}

export function readKillLines() {
	const path = join(root, "kills.jsonl");
	return existsSync(path) ? readJsonLines(path) : [];
}

export function runFile(name: string, file: string) {
	const path = join(root, name, file);
	return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

/* Every wait in this file is on an event, under a ceiling far above what an
 * unloaded run takes: WATCH_READY_S alone can hold a publish 5 s, and a high
 * ceiling costs nothing when the event comes early (#2674). Low enough that a
 * case's three waits in a row fit the 90 s TEST_TIMEOUT_MS, so a timeout
 * names the wait that ran out rather than the case. */
export const CEILING_MS = 20_000;
/* A guess, unmeasured: fine enough to add little to an event's latency,
 * coarse enough that a full ceiling is 400 reads. */
export const POLL_MS = 50;

/* Whether `ready` came true within CEILING_MS. */
export async function poll(ready: () => boolean, everyMs = POLL_MS) {
	const by = Date.now() + CEILING_MS;
	while (!ready() && Date.now() < by) await sleep(everyMs);
	return ready();
}

export async function waitFor(what: string, ready: () => boolean) {
	expect(await poll(ready), `timed out waiting for ${what}`).toBe(true);
}

/* The same wait in shell, for a child process to run: `cond` retried every
 * POLL_MS, up to CEILING_MS. */
export function shWaitFor(cond: string) {
	const tries = CEILING_MS / POLL_MS;
	return `i=0; until ${cond} || [ $i -ge ${tries} ]; do sleep ${POLL_MS / 1000}; i=$((i+1)); done`;
}

/* `cmd_run` holds its publish until its watcher is up (#2110): before then
 * there is no run directory, so a kill leaves nothing to read. */
export const untilPublished = (name: string) =>
	waitFor(`${name}'s run to publish`, () => runFile(name, "token") !== "");

/* The wrapped command has started, and run as far as printing `text`. */
export const untilPrinted = (name: string, text: string) =>
	waitFor(`${name}'s command to print ${text}`, () =>
		runFile(name, "out").includes(text),
	);

export const republished = (name: string, oldToken: string) => () => {
	const token = runFile(name, "token");
	return token !== "" && token !== oldToken;
};

/* Exact argv elements, not a pattern: a pattern also matches whatever
 * process carries it on its own command line. */
export function readWatcherPids(token: string) {
	return readdirSync("/proc").filter((pid) => {
		if (!/^\d+$/.test(pid)) return false;
		try {
			const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
			return argv.includes("__watch") && argv.includes(token);
		} catch {
			return false; // exited between the listing and the read
		}
	});
}

/* Detached so a kill of `-pid` takes the wrapper's whole group, as the
 * harness does; the setsid'd watcher is outside it. */
export function spawnDetached(args: string[], spawnEnv: NodeJS.ProcessEnv) {
	const child = spawn(SCRIPT, args, { env: spawnEnv, detached: true });
	if (child.pid === undefined) throw new Error("spawn did not return a pid");
	return { child, pid: child.pid };
}

/* `check` again until it stops saying RUNNING, so a kill is read once the
 * staleness window has opened, however long the machine took to open it. */
export async function untilVerdict(name: string) {
	let got: ReturnType<typeof check> | undefined;
	await poll(() => {
		got = check(name);
		return got.status !== 2;
	}, 250); // a guess, unmeasured: each `check` is a bash spawn, not a file read
	return got as ReturnType<typeof check>;
}

/* Just before a case kills `name`'s wrapper `pid` (#2689). A kill landing
 * after the command returned meets a wrapper that has written `status` and
 * exited, so the case would read DONE and fail on a verdict mismatch; this
 * names the cause instead. */
export function expectMidCommand(name: string, pid: number | undefined) {
	expect(
		runFile(name, "status"),
		`${name}'s command had already finished before the kill`,
	).toBe("");
	expect(
		pid !== undefined && !isDead(pid),
		`${name}'s wrapper had already exited before the kill`,
	).toBe(true);
}

/* A command that runs until the test creates `go`, so its runtime is the
 * test's to end rather than a guess at how long the test takes to act. */
export const runsUntilFile = (go: string) => shWaitFor(`[ -e '${go}' ]`);

export function parseFirstLine(stdout: string) {
	return stdout.split("\n")[0];
}

/* `cmd_run` removes and recreates its directory before doing anything else
 * observable, so a caller reaching `check`/`wait` right after `run ... &` can
 * beat that `mkdir`. These simulate the race directly — creating the
 * directory a beat late, the way a slow-to-schedule `run` would — rather than
 * relying on `cmd_run`'s own timing, which is out of scope to change.
 *
 * The delayed creation runs in its own OS process (`sh -c`), not
 * a `setTimeout` in this process: the assertions below use the blocking
 * `spawnSync` helper, which would otherwise starve Node's event loop and
 * never let a same-process timer fire before `check`/`wait` had already
 * returned. It builds `beat`/`out`/`status` in a sibling `.tmp` directory and
 * `mv`s it into place last, so the run directory never appears half-built —
 * without that, a poll landing between the plain `mkdir` and the `beat`
 * write would read a *different* race (`cmd_check`'s "KILLED before the first
 * beat", `scripts/bg-run.sh:207-211`, mantahostels#2666). `stdio: "ignore"` plus `unref()` so a slow child cannot hold
 * the test process open or outlive `afterEach`'s cleanup.
 *
 * It creates the directory once the caller's first retry has logged its miss,
 * so the caller always retries: a fixed delay is one a `check` slower to
 * start than it outruns, finding the directory on its first look (#2674).
 * Each caller widens MISSING_S with WIDE_MISSING, since the creation waits on
 * the retry. */
export const WIDE_MISSING = { WFC_BG_MISSING_S: "10" };

export function createDirLate(dir: string, withStatus: boolean) {
	const tmp = `${dir}.tmp`;
	const log = join(root, "polls.log");
	const cmds = [
		shWaitFor(`grep -qx missing '${log}' 2>/dev/null`),
		`mkdir -p '${tmp}'`,
		`: >'${tmp}/beat'`,
		`: >'${tmp}/out'`,
	];
	if (withStatus) cmds.push(`printf 'exit=0\\n' >'${tmp}/status'`);
	cmds.push(`mv '${tmp}' '${dir}'`);
	spawn("sh", ["-c", cmds.join(" && ")], { stdio: "ignore" }).unref();
}

/** The case's WFC_BG_ROOT, fresh for each case once bgRunRoot() is called. */
export let root: string;

/** Register the beforeEach/afterEach that make and remove `root`, killing
 * every process a case left under it. */
export function bgRunRoot(): void {
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "bg-run-test-"));
	});

	afterEach(() => {
		for (const pid of readProcessesUnder(root)) {
			try {
				process.kill(Number(pid), "SIGKILL");
			} catch {
				// exited since the scan
			}
		}
		rmSync(root, { recursive: true, force: true });
	});
}
