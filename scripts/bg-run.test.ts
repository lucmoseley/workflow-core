// @vitest-environment node
/*
 * bg-run.test.ts — the one guarantee scripts/bg-run.sh sells: a killed run and
 * a finished run are told apart, by a signal the job itself writes.
 *
 * The kill arm SIGKILLs the wrapper, which is what the harness does to a
 * background job (mantahostels#1900) — the toucher dies with it, the status file is never
 * written, and `check` has only the stale beat to go on.
 *
 * A `--full` or `--queue` suite run is wrapped in bg-run.sh, and the
 * `PreToolUse` guards lib/bg-job.js and lib/suite-background.js point
 * sessions at its `check`: loosen a case and a suite the harness killed
 * half-way reads as finished, its partial greens taken for a result.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isDead } from "./lib/process-fixture";

const { waitForGate } = require("./lib/suite-queue.js");
const { TEST_TIMEOUT_MS } = require("./lib/test-ceiling.js");

const SCRIPT = join(__dirname, "bg-run.sh");

/* Fast beats so the kill arms do not spend twenty seconds each waiting for the
 * default staleness window to open. */
const FAST = {
	WFC_BG_HEARTBEAT_S: "1",
	WFC_BG_STALE_S: "2",
	WFC_BG_WAIT_POLL_S: "1",
	/* Short enough that the "never launched" tests below don't pay the full
	 * 2s default retry. The fabricated-directory race tests set their own,
	 * WIDE_MISSING. */
	WFC_BG_MISSING_S: "1.5",
	WFC_BG_MISSING_POLL_S: "0.1",
};

let root: string;

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

/* How long a command a case kills runs if left alone (#2689): past the case's
 * own timeout, so no stall the case survives carries its kill past the
 * command's end. The 30 s beyond it is a guess, for a timeout a stalled
 * event loop fires late. A wrapper-alone kill orphans the command, which
 * afterEach ends rather than leaving it to run out. */
const KILLED_LIFETIME_S = String(TEST_TIMEOUT_MS / 1000 + 30);

/* Every process launched with WFC_BG_ROOT exactly `dir`, as env() sets it:
 * wrappers, watchers and orphaned commands all inherit it. Any other process
 * a case starts owes its own kill. */
function readProcessesUnder(dir: string) {
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

function env(extra: Record<string, string> = {}) {
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
const BOUNDED = { timeout: 60_000, killSignal: "SIGKILL" } as const;

function run(args: string[], extra: Record<string, string> = {}) {
	return spawnSync(SCRIPT, args, {
		env: env(extra),
		encoding: "utf8",
		...BOUNDED,
	});
}

function check(name: string, extra: Record<string, string> = {}) {
	return run(["check", name], extra);
}

/* `run` above can only ADD to the environment, and several of the launch-log
 * tests (mantahostels#2763) turn on a variable being ABSENT. */
function runWithout(drop: string[], args: string[]) {
	const clean: NodeJS.ProcessEnv = { ...env() };
	for (const key of drop) delete clean[key];
	return spawnSync(SCRIPT, args, { env: clean, encoding: "utf8", ...BOUNDED });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readJsonLines(path: string) {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l));
}

function readKillLines() {
	const path = join(root, "kills.jsonl");
	return existsSync(path) ? readJsonLines(path) : [];
}

function runFile(name: string, file: string) {
	const path = join(root, name, file);
	return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

/* Every wait in this file is on an event, under a ceiling far above what an
 * unloaded run takes: WATCH_READY_S alone can hold a publish 5 s, and a high
 * ceiling costs nothing when the event comes early (#2674). Low enough that a
 * case's three waits in a row fit the 90 s TEST_TIMEOUT_MS, so a timeout
 * names the wait that ran out rather than the case. */
const CEILING_MS = 20_000;
/* A guess, unmeasured: fine enough to add little to an event's latency,
 * coarse enough that a full ceiling is 400 reads. */
const POLL_MS = 50;

/* Whether `ready` came true within CEILING_MS. */
async function poll(ready: () => boolean, everyMs = POLL_MS) {
	const by = Date.now() + CEILING_MS;
	while (!ready() && Date.now() < by) await sleep(everyMs);
	return ready();
}

async function waitFor(what: string, ready: () => boolean) {
	expect(await poll(ready), `timed out waiting for ${what}`).toBe(true);
}

/* The same wait in shell, for a child process to run: `cond` retried every
 * POLL_MS, up to CEILING_MS. */
function shWaitFor(cond: string) {
	const tries = CEILING_MS / POLL_MS;
	return `i=0; until ${cond} || [ $i -ge ${tries} ]; do sleep ${POLL_MS / 1000}; i=$((i+1)); done`;
}

/* `cmd_run` holds its publish until its watcher is up (#2110): before then
 * there is no run directory, so a kill leaves nothing to read. */
const untilPublished = (name: string) =>
	waitFor(`${name}'s run to publish`, () => runFile(name, "token") !== "");

/* The wrapped command has started, and run as far as printing `text`. */
const untilPrinted = (name: string, text: string) =>
	waitFor(`${name}'s command to print ${text}`, () =>
		runFile(name, "out").includes(text),
	);

const republished = (name: string, oldToken: string) => () => {
	const token = runFile(name, "token");
	return token !== "" && token !== oldToken;
};

/* Exact argv elements, not a pattern: a pattern also matches whatever
 * process carries it on its own command line. */
function readWatcherPids(token: string) {
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
function spawnDetached(args: string[], spawnEnv: NodeJS.ProcessEnv) {
	const child = spawn(SCRIPT, args, { env: spawnEnv, detached: true });
	if (child.pid === undefined) throw new Error("spawn did not return a pid");
	return { child, pid: child.pid };
}

/* `check` again until it stops saying RUNNING, so a kill is read once the
 * staleness window has opened, however long the machine took to open it. */
async function untilVerdict(name: string) {
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
function expectMidCommand(name: string, pid: number | undefined) {
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
const runsUntilFile = (go: string) => shWaitFor(`[ -e '${go}' ]`);

describe("a run that finishes", () => {
	it("reports DONE with the command's exit code", () => {
		run(["run", "ok", "sh", "-c", "exit 0"]);
		const got = check("ok");
		expect(got.stdout).toContain("DONE exit=0");
		expect(got.status).toBe(0);
	});

	it("carries a non-zero exit code through rather than flattening it", () => {
		const ran = run(["run", "bad", "sh", "-c", "exit 7"]);
		expect(ran.status).toBe(7);
		expect(check("bad").stdout).toContain("DONE exit=7");
	});

	it("ends a command that returns as soon as the toucher holds the wrapper's TERM trap (#2675)", () => {
		const armed = join(root, "armed");
		const ran = run(
			["run", "instant", "sh", "-c", shWaitFor(`[ -e '${armed}' ]`)],
			{ WFC_BG_TOUCHER_KEEPS_TRAP: armed },
		);
		expect(ran.error).toBeUndefined();
		expect(existsSync(armed)).toBe(true);
		expect(ran.status).toBe(0);
		expect(runFile("instant", "status")).toBe("exit=0");
	});

	it("captures the command's stdout and stderr in one file", () => {
		run(["run", "noisy", "sh", "-c", "echo out; echo err >&2"]);
		const out = readFileSync(join(root, "noisy", "out"), "utf8");
		expect(out).toContain("out");
		expect(out).toContain("err");
	});
});

describe("a run that is killed", () => {
	it("reports KILLED, not DONE, when the wrapper is SIGKILLed mid-command", async () => {
		const child = spawn(SCRIPT, ["run", "doomed", "sleep", KILLED_LIFETIME_S], {
			env: env(),
		});
		await untilPublished("doomed");
		expectMidCommand("doomed", child.pid);
		child.kill("SIGKILL");

		const got = await untilVerdict("doomed");
		expect(got.stdout).toContain("KILLED");
		expect(got.stdout).not.toContain("DONE");
		expect(got.status).toBe(1);
	});

	it("leaves no status file behind, which is what makes the kill legible", async () => {
		const child = spawn(
			SCRIPT,
			["run", "nostatus", "sleep", KILLED_LIFETIME_S],
			{
				env: env(),
			},
		);
		await untilPublished("nostatus");
		expectMidCommand("nostatus", child.pid);
		child.kill("SIGKILL");
		expect((await untilVerdict("nostatus")).status).toBe(1);

		expect(existsSync(join(root, "nostatus", "status"))).toBe(false);
		expect(existsSync(join(root, "nostatus", "beat"))).toBe(true);
	});
});

describe("a run still going", () => {
	it("reports RUNNING rather than guessing either way", async () => {
		const child = spawn(SCRIPT, ["run", "live", "sleep", KILLED_LIFETIME_S], {
			env: env(),
		});
		await untilPublished("live");

		const got = check("live");
		expect(got.stdout).toContain("RUNNING");
		expect(got.status).toBe(2);

		child.kill("SIGKILL");
	});
});

function parseFirstLine(stdout: string) {
	return stdout.split("\n")[0];
}

/* What `wait` and the missing-directory retry did, so a case counts the polls
 * rather than timing them (base §X9): each `wait` poll's cmd_check exit code
 * in order, and how many retries found no directory. */
function readPolls(): { wait: string[]; missing: number } {
	const at = join(root, "polls.log");
	const lines = existsSync(at)
		? readFileSync(at, "utf8").split("\n").filter(Boolean)
		: [];
	return {
		wait: lines.filter((l) => l !== "missing"),
		missing: lines.filter((l) => l === "missing").length,
	};
}

/* `wait` polled while RUNNING (exit 2), then stopped at the first `verdict`
 * rather than sleeping on to its ceiling. */
function expectPolledUntil(verdict: string) {
	const seen = readPolls().wait;
	expect(new Set(seen.slice(0, -1))).toEqual(new Set(["2"]));
	expect(seen.at(-1)).toBe(verdict);
}

describe("inline output", () => {
	it("prints the file's bytes after the verdict line, not just its path", () => {
		run(["run", "chatty", "sh", "-c", "echo hello there"]);
		const got = check("chatty");
		expect(got.status).toBe(0);
		expect(got.stdout).toContain("out=");
		expect(got.stdout).toContain("bytes=");
		expect(got.stdout).toContain("hello there");
	});

	it("truncates to the cap and says so, showing the tail rather than the head", () => {
		run(["run", "big", "sh", "-c", "printf 'AAAAAAAAAA\\nBBBBBBBBBB\\n'"]);
		const got = run(["check", "big"]);
		const capped = spawnSync(SCRIPT, ["check", "big"], {
			env: env({ WFC_BG_INLINE_CAP: "5" }),
			encoding: "utf8",
			...BOUNDED,
		});
		expect(got.status).toBe(0);
		expect(capped.status).toBe(0);
		expect(got.stdout).toContain("AAAAAAAAAA");
		expect(capped.stdout).toContain("(last 5 shown)");
		expect(capped.stdout).not.toContain("AAAAAAAAAA");
		expect(capped.stdout).toContain("BBBB");
	});
});

/* Async `spawn` throughout this block, not the `run()`/`spawnSync` helper: a
 * blocking `wait` call has to run concurrently with the test killing or
 * finishing the job it is watching, which `spawnSync` — blocking this whole
 * process's event loop — cannot do. Each verdict is asserted on stdout's
 * FIRST LINE, not the whole blob: the inlined job output shares that stream,
 * so a job whose own text happens to contain "DONE" or "KILLED" would
 * otherwise pass a `toContain` check that never looked at the verdict. */
describe("wait", () => {
	function wait(name: string, ceiling: string) {
		return run(["wait", name, ceiling]);
	}

	function spawnWait(name: string, ceiling: string) {
		const child = spawn(SCRIPT, ["wait", name, ceiling], { env: env() });
		let stdout = "";
		child.stdout.on("data", (d) => {
			stdout += d;
		});
		const done = new Promise<{ status: number | null; stdout: string }>(
			(resolve) => {
				child.on("close", (status) => resolve({ status, stdout }));
			},
		);
		return done;
	}

	it("returns as soon as an already-finished job is found, not at the ceiling", () => {
		run(["run", "quick", "sh", "-c", "echo done-output"]);
		const got = wait("quick", "5");
		expect(got.status).toBe(0);
		expect(parseFirstLine(got.stdout)).toContain("DONE exit=0");
		expect(got.stdout).toContain("done-output");
		expect(readPolls().wait).toEqual(["0"]);
	});

	it("detects a job finishing partway through its own poll loop", async () => {
		const go = join(root, "go");
		spawn(
			SCRIPT,
			[
				"run",
				"midfinish",
				"sh",
				"-c",
				`${runsUntilFile(go)}; echo late-output`,
			],
			{
				env: env(),
			},
		);
		await untilPublished("midfinish");
		const waiting = spawnWait("midfinish", "60");
		await waitFor("wait to poll the run RUNNING", () =>
			readPolls().wait.includes("2"),
		);
		writeFileSync(go, "");
		const got = await waiting;
		expect(got.status).toBe(0);
		expect(parseFirstLine(got.stdout)).toContain("DONE exit=0");
		expect(got.stdout).toContain("late-output");
		/* Polled while RUNNING, then stopped at the first DONE rather than
		 * sleeping on to the ceiling. */
		expectPolledUntil("0");
	});

	it("reports RUNNING once the ceiling expires on a still-live job", async () => {
		const child = spawn(SCRIPT, ["run", "slow", "sleep", KILLED_LIFETIME_S], {
			env: env(),
		});
		await untilPublished("slow");
		const got = wait("slow", "1");
		expect(got.status).toBe(2);
		expect(parseFirstLine(got.stdout)).toContain("RUNNING");
		child.kill("SIGKILL");
	});

	it("detects a wrapper killed while wait is already blocking on it", async () => {
		const runChild = spawn(
			SCRIPT,
			["run", "midkill", "sleep", KILLED_LIFETIME_S],
			{
				env: env(),
			},
		);
		await untilPublished("midkill");
		const waiting = spawnWait("midkill", "60");
		await waitFor("wait to poll the run RUNNING", () =>
			readPolls().wait.includes("2"),
		);
		expectMidCommand("midkill", runChild.pid);
		runChild.kill("SIGKILL");
		const got = await waiting;
		expect(got.status).toBe(1);
		expect(parseFirstLine(got.stdout)).toContain("KILLED");
		/* Polled while RUNNING through the staleness window, then stopped at
		 * the first KILLED rather than sleeping on to the ceiling. */
		expectPolledUntil("1");
	});

	it("refuses a name it has never run, same as check", () => {
		const got = wait("never-waited", "1");
		expect(got.status).toBe(3);
		expect(got.stderr).toContain("no run named");
	});
});

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
const WIDE_MISSING = { WFC_BG_MISSING_S: "10" };

/* MISSING_S's retries at bg-run.sh's defaults: 2 s of 0.1 s polls. */
const DEFAULT_MISSING_POLLS = Math.round(2 / 0.1);

function createDirLate(dir: string, withStatus: boolean) {
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

describe("the run-directory creation race", () => {
	it("does not report 'no run named' when the directory lands inside the window", () => {
		createDirLate(join(root, "racy"), false);
		const got = check("racy", WIDE_MISSING);
		expect(got.stderr).not.toContain("no run named");
		expect(got.status).not.toBe(3);
		expect(got.stdout).toContain("RUNNING");
		/* Proves this actually retried rather than happening to win a race
		 * against a slow spawn: a check that returned before the directory
		 * could possibly exist would pass this assertion for the wrong
		 * reason. */
		expect(readPolls().missing).toBeGreaterThan(0);
	});

	it("gives an actual 'run' the same grace, not just a fabricated directory", () => {
		/* `run ... &` immediately followed by `check`/`wait` on the same name.
		 * cmd_run's own rm -rf + mv is fast, so this cannot force the loss the
		 * way createDirLate can — but it proves the fix holds against the
		 * actual code path, not just the simulation above. */
		const child = spawn(
			SCRIPT,
			["run", "reallive", "sleep", KILLED_LIFETIME_S],
			{ env: env() },
		);
		const got = check("reallive");
		expect(got.stderr).not.toContain("no run named");
		expect(got.status).not.toBe(3);
		child.kill("SIGKILL");
	});

	it("waits out a publish held past MISSING_S for a slow watcher, at the production defaults (#2688)", () => {
		/* A 3 s fork delay holds the publish past MISSING_S's 2 s default. On
		 * the real clock at the defaults, since the defect is how the two
		 * defaults relate, WATCH_READY_S above MISSING_S. */
		const { pid } = spawnDetached(
			["run", "held", "sleep", KILLED_LIFETIME_S],
			env({ WFC_BG_WATCH_FORK_DELAY_S: "3" }),
		);
		try {
			const got = runWithout(
				["WFC_BG_MISSING_S", "WFC_BG_MISSING_POLL_S"],
				["check", "held"],
			);
			expect(got.stderr).not.toContain("no run named");
			expect(got.status).toBe(2); // RUNNING
			/* Past MISSING_S's own retries, so the held-publish wait answered. */
			expect(readPolls().missing).toBeGreaterThan(DEFAULT_MISSING_POLLS);
		} finally {
			process.kill(-pid, "SIGKILL");
		}
	});

	it("finds a held publish in the root its last launch line pins, for a checker whose root moved (#2688)", async () => {
		expect(run(["run", "moved", "true"]).status).toBe(0);
		const { pid } = spawnDetached(
			["run", "moved", "sleep", KILLED_LIFETIME_S],
			env({ WFC_BG_WATCH_FORK_DELAY_S: "3" }),
		);
		try {
			/* A check that beats the re-run's start reads the first run's DONE
			 * directory. Its status file stays gone from then on. */
			await waitFor(
				"the re-run to move the first run aside",
				() => !existsSync(join(root, "moved", "status")),
			);
			const elsewhere = join(root, "elsewhere");
			mkdirSync(elsewhere);
			const clean: NodeJS.ProcessEnv = { ...env(), WFC_BG_ROOT: elsewhere };
			delete clean.WFC_BG_MISSING_S;
			delete clean.WFC_BG_MISSING_POLL_S;
			const got = spawnSync(SCRIPT, ["check", "moved"], {
				env: clean,
				encoding: "utf8",
				...BOUNDED,
			});
			expect(got.stderr).not.toContain("no run named");
			expect(got.status).toBe(2); // RUNNING
		} finally {
			process.kill(-pid, "SIGKILL");
		}
	});

	it("gives 'wait' the same held-publish grace (#2688)", () => {
		const { pid } = spawnDetached(
			["run", "held-wait", "sh", "-c", "exit 0"],
			env({ WFC_BG_WATCH_FORK_DELAY_S: "3" }),
		);
		try {
			const got = runWithout(
				["WFC_BG_MISSING_S", "WFC_BG_MISSING_POLL_S"],
				["wait", "held-wait", "20"],
			);
			expect(got.stderr).not.toContain("no run named");
			expect(parseFirstLine(got.stdout)).toContain("DONE exit=0");
			expect(readPolls().missing).toBeGreaterThan(DEFAULT_MISSING_POLLS);
		} finally {
			process.kill(-pid, "SIGKILL");
		}
	});

	it("refuses a never-launched name within MISSING_S at the production defaults, the held-publish wait unspent (#2688)", () => {
		const got = runWithout(
			["WFC_BG_MISSING_S", "WFC_BG_MISSING_POLL_S"],
			["check", "never-held"],
		);
		expect(got.status).toBe(3);
		expect(got.stderr).toContain("no run named");
		/* The held-publish wait logs retries of its own, so one entered would
		 * push the count past MISSING_S's. */
		expect(readPolls().missing).toBeLessThanOrEqual(DEFAULT_MISSING_POLLS);
	});

	it("still refuses a name that was never launched, within a bounded time", () => {
		const windowS = 0.4;
		const pollS = 0.05;
		const tight = {
			WFC_BG_MISSING_S: String(windowS),
			WFC_BG_MISSING_POLL_S: String(pollS),
		};
		const got = check("well-and-truly-never", tight);
		expect(got.status).toBe(3);
		expect(got.stderr).toContain("no run named");
		/* It retried rather than failing at once, and stopped at the window:
		 * each retry sleeps its poll of the window first, so no machine fits
		 * one more. */
		const { missing } = readPolls();
		expect(missing).toBeGreaterThan(0);
		expect(missing).toBeLessThanOrEqual(Math.round(windowS / pollS));
	});

	it("gives 'wait' the same grace, not just 'check'", () => {
		createDirLate(join(root, "racy-wait"), true);
		const got = run(["wait", "racy-wait", "3"], WIDE_MISSING);
		expect(got.stderr).not.toContain("no run named");
		expect(parseFirstLine(got.stdout)).toContain("DONE exit=0");
	});
});

describe("a relaunch whose old directory is written mid-delete (#1355)", () => {
	it("still publishes and runs when the old run's watcher writes into it", () => {
		/* A stub `rm` ahead of the real one on PATH (base §N7's route for an
		 * exempt tool) plays the old watcher: on any directory holding a
		 * `token` it deletes for real, then puts back `.kill-recorded` and
		 * exits 1, as a `mkdir` landing after rm read the listing leaves it. */
		expect(run(["run", "relaunched", "true"]).status).toBe(0);
		const bin = join(root, "bin");
		mkdirSync(bin);
		const realRm = execFileSync("sh", ["-c", "command -v rm"], {
			encoding: "utf8",
		}).trim();
		writeFileSync(
			join(bin, "rm"),
			`#!/usr/bin/env bash
marked=()
for a in "$@"; do [ -f "$a/token" ] && marked+=("$a"); done
"${realRm}" "$@"
for a in "\${marked[@]}"; do mkdir -p "$a/.kill-recorded"; done
[ "\${#marked[@]}" -eq 0 ]
`,
			{ mode: 0o755 },
		);

		const got = run(["run", "relaunched", "true"], {
			PATH: `${bin}:${process.env.PATH}`,
		});
		expect(got.stderr).not.toContain("cannot publish");
		expect(got.status).toBe(0);
		expect(readFileSync(join(root, "relaunched", "status"), "utf8")).toBe(
			"exit=0\n",
		);
		expect(existsSync(join(root, "relaunched", ".kill-recorded"))).toBe(false);
	});
});

describe("a check overlapping a same-name re-run (#3097)", () => {
	/* WFC_BG_CHECK_GATE holds the check at `<gate>.<try>` after each try's
	 * token read and at `<gate>.record` before its kill record; each case
	 * opens up front the gates it does not hold at. */
	const gate = () => join(root, "gate");
	const openGate = (point: string) => writeFileSync(`${gate()}.${point}`, "");
	const atGate = (point: string) =>
		waitFor(`the check to hold at ${point}`, () =>
			existsSync(`${gate()}.${point}.waiting`),
		);

	function gatedCheck(name: string) {
		const child = spawn(SCRIPT, ["check", name], {
			env: env({ WFC_BG_CHECK_GATE: gate(), ...WIDE_MISSING }),
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const exited = new Promise<{
			status: number | null;
			stdout: string;
			stderr: string;
		}>((done) =>
			child.on("exit", (status) => done({ status, stdout, stderr })),
		);
		return { child, exited };
	}

	/* cmd_run's own rename to the grave, made by the case inside a gate. */
	const toGrave = (name: string, n: number) =>
		renameSync(join(root, name), join(root, `.grave-${name}-${n}`));

	it("answers for the re-run, recording no kill, when the old directory goes to its grave mid-read", async () => {
		/* A read that went on from the rename would find no beat and call the
		 * old run killed. */
		expect(
			run(["run", "regraved", "sh", "-c", "echo first-output; exit 7"]).status,
		).toBe(7);
		openGate("2");
		openGate("record");
		const { child, exited } = gatedCheck("regraved");
		try {
			await atGate("1");
			toGrave("regraved", 1);
			openGate("1");
			await waitFor("the check to look again", () => readPolls().missing > 0);
			expect(
				run(["run", "regraved", "sh", "-c", "echo second-output"]).status,
			).toBe(0);

			const got = await exited;
			expect(got.status).toBe(0);
			expect(parseFirstLine(got.stdout)).toBe("DONE exit=0");
			expect(got.stdout).toContain("second-output");
			expect(got.stdout).not.toContain("first-output");
			expect(readKillLines().filter((l) => l.name === "regraved")).toHaveLength(
				0,
			);
		} finally {
			child.kill("SIGKILL");
		}
	});

	it("says it raced, UNKNOWN and recording no kill, when the run is replaced on both tries", async () => {
		expect(run(["run", "twice", "true"]).status).toBe(0);
		openGate("record");
		const { child, exited } = gatedCheck("twice");
		try {
			await atGate("1");
			toGrave("twice", 1);
			openGate("1");
			await waitFor("the check to look again", () => readPolls().missing > 0);
			expect(run(["run", "twice", "true"]).status).toBe(0);
			await atGate("2");
			toGrave("twice", 2);
			openGate("2");

			const got = await exited;
			expect(got.status).toBe(3);
			expect(got.stderr).toContain(
				"run twice was replaced twice while check read it",
			);
			expect(readKillLines().filter((l) => l.name === "twice")).toHaveLength(0);
		} finally {
			child.kill("SIGKILL");
		}
	});

	it("puts no kill record in a re-run that publishes between the read and the record", async () => {
		const { pid: firstPid } = spawnDetached(
			["run", "rerecorded", "sleep", KILLED_LIFETIME_S],
			env(),
		);
		let secondPid: number | undefined;
		let child: ReturnType<typeof gatedCheck>["child"] | undefined;
		try {
			await untilPublished("rerecorded");
			const firstToken = runFile("rerecorded", "token");
			expectMidCommand("rerecorded", firstPid);
			process.kill(-firstPid, "SIGKILL");
			expect(
				parseFirstLine((await untilVerdict("rerecorded")).stdout),
			).toContain("KILLED");
			openGate("1");
			openGate("2");
			const gated = gatedCheck("rerecorded");
			child = gated.child;
			await atGate("record");

			secondPid = spawnDetached(
				["run", "rerecorded", "sleep", KILLED_LIFETIME_S],
				env(),
			).pid;
			await waitFor(
				"the re-run to publish",
				republished("rerecorded", firstToken),
			);
			openGate("record");

			const got = await gated.exited;
			expect(got.status).toBe(1);
			expect(parseFirstLine(got.stdout)).toContain("KILLED");
			expect(existsSync(join(root, "rerecorded", ".kill-recorded"))).toBe(
				false,
			);
		} finally {
			child?.kill("SIGKILL");
			for (const pid of [firstPid, secondPid]) {
				try {
					if (pid !== undefined) process.kill(-pid, "SIGKILL");
				} catch {
					// already killed above
				}
			}
		}
	});
});

describe("the beat-write race (mantahostels#2666)", () => {
	it("still reports 'KILLED before the first beat' when beat is genuinely absent", () => {
		/* The positive half: proves the string this whole ticket is about is
		 * still reachable at all, so the test below (which only proves the
		 * string is ABSENT) cannot pass vacuously against a `cmd_check` that
		 * had the branch deleted outright. A directory with `out` but no
		 * `beat` — what a killed-before-first-beat run leaves — built directly
		 * rather than via `run`, since the fix means `run` itself can no
		 * longer produce this state. */
		const dir = join(root, "no-beat-yet");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "out"), "");
		const got = check("no-beat-yet");
		expect(got.stdout).toContain("KILLED before the first beat");
		expect(got.status).toBe(1);
	});

	it("never reports 'KILLED before the first beat' for a run barely started", async () => {
		/* cmd_run builds beat/out in a sibling .tmp directory and `mv -T`s
		 * it into place, the same pattern createDirLate uses above, so the run
		 * directory cannot appear to another process without beat/out already
		 * in it — there is no window left to force the way the mkdir race
		 * above can be forced. Hammering `check` across the publish is the
		 * only way left to exercise the real code path. One `check` straddles
		 * the publish by construction: the run is spawned only once that check
		 * has logged a miss, so it is still retrying when the directory lands,
		 * however slowly either starts (#2674). Its exit 2 proves it read the
		 * published run, without which this would pass whether or not the fix
		 * holds. */
		const straddler = spawn(SCRIPT, ["check", "beat-race"], {
			env: env(WIDE_MISSING),
		});
		let out = "";
		straddler.stdout.on("data", (d) => {
			out += d;
		});
		const exited = new Promise<number | null>((r) => straddler.on("close", r));
		await waitFor("the check's first miss", () => readPolls().missing > 0);
		const child = spawn(
			SCRIPT,
			["run", "beat-race", "sleep", KILLED_LIFETIME_S],
			{
				env: env(),
			},
		);
		const status = await exited;
		child.kill("SIGKILL");
		expect(out).not.toContain("KILLED before the first beat");
		expect(status).toBe(2);
	});
});

describe("what the toucher must not change about the command (mantahostels#2662)", () => {
	it("still delivers the command's own stdin, unmodified by running under the toucher", async () => {
		const child = spawn(
			SCRIPT,
			["run", "stdin-echo", "sh", "-c", 'read x; echo "[$x]"'],
			{
				env: env(),
			},
		);
		child.stdin.write("hello\n");
		child.stdin.end();
		await untilPublished("stdin-echo");
		const got = run(["wait", "stdin-echo", "60"]);
		expect(got.stdout).toContain("[hello]");
	});
});

describe("the memory sample's descendant walk (mantahostels#2683)", () => {
	it("counts a grandchild the wrapped command forks, not just its own launcher", async () => {
		const name = "forked-worker";
		/* The worker script is its own process, launched by `sh -c` backgrounding
		 * it — a grandchild of bg-run.sh, not a direct child. It holds ~20MB in a
		 * shell variable so its RSS is unmistakable against a launcher (`sh`
		 * itself) too small to explain the total on its own. */
		const workerPath = join(root, "worker.sh");
		writeFileSync(
			workerPath,
			`#!/bin/sh\nx=$(head -c 20000000 /dev/zero | tr '\\0' 'a')\nsleep ${KILLED_LIFETIME_S}\n`,
			{ mode: 0o755 },
		);
		const proc = spawn(
			SCRIPT,
			["run", name, "sh", "-c", `${workerPath} & wait`],
			{
				env: env(),
			},
		);

		let rssKb = 0;
		let memContent = "";
		await poll(() => {
			memContent = runFile(name, "mem");
			rssKb = Number(memContent.match(/rss_kb=(\d+)/)?.[1] ?? 0);
			return rssKb > 15_000;
		});

		proc.kill("SIGKILL");

		/* Direct-children-only counts just `sh`, a few MB at most — nowhere
		 * near the ~20MB the worker script grandchild alone is holding. */
		expect(rssKb).toBeGreaterThan(15_000);
		/* A two-process tree sits nowhere near the default 500-visit cap, so
		 * the sample is complete, not a partial figure standing in for one. */
		expect(memContent).toMatch(/rss_truncated=false/);
	});

	it("marks the sample truncated when the descendant cap is hit, so a capped sum is never read as a complete one (mantahostels#2683)", async () => {
		const name = "capped-worker";
		const workerPath = join(root, "worker-capped.sh");
		writeFileSync(workerPath, `#!/bin/sh\nsleep ${KILLED_LIFETIME_S}\n`, {
			mode: 0o755,
		});
		const proc = spawn(
			SCRIPT,
			["run", name, "sh", "-c", `${workerPath} & wait`],
			{
				/* Cap at 1: `sh` itself is the only visit the walk gets, so the
				 * worker script grandchild is never reached — the cap fires on a
				 * tree two levels deep, not one it can't otherwise walk. */
				env: env({ WFC_BG_MAX_DESCENDANTS: "1" }),
			},
		);

		let memContent = "";
		await poll(() => {
			memContent = runFile(name, "mem");
			return memContent !== "";
		});

		proc.kill("SIGKILL");

		expect(memContent).toMatch(/rss_truncated=true/);
	});
});

describe("the kill record (mantahostels#2662)", () => {
	it("appends nothing for a run that finishes cleanly", () => {
		run(["run", "clean", "sh", "-c", "exit 0"]);
		check("clean");
		expect(existsSync(join(root, "kills.jsonl"))).toBe(false);
	});

	it("appends one record, with the field shapes the ticket asks for, on a killed run", async () => {
		const child = spawn(
			SCRIPT,
			["run", "recorded", "sleep", KILLED_LIFETIME_S],
			{
				env: env(),
			},
		);
		/* Killed once the first memory sample lands, one heartbeat in. */
		await waitFor(
			"the first memory sample",
			() => runFile("recorded", "mem") !== "",
		);
		expectMidCommand("recorded", child.pid);
		child.kill("SIGKILL");
		expect((await untilVerdict("recorded")).status).toBe(1);

		const lines = readKillLines();
		expect(lines).toHaveLength(1);
		const rec = lines[0];
		expect(rec.name).toBe("recorded");
		expect(rec.reason).toBe("stale-beat");
		expect(Number.isFinite(Number(rec.elapsed_s))).toBe(true);
		expect(Number(rec.elapsed_s)).toBeGreaterThanOrEqual(0);
		expect(["passed", "waiting", "n/a"]).toContain(rec.queue_state);
		expect(typeof rec.out_bytes).toBe("number");
		expect(rec.out_exists).toBe(true);
		expect(Number.isFinite(Number(rec.mem_available_mb))).toBe(true);
		expect(Number.isFinite(Number(rec.rss_kb))).toBe(true);
		expect(Number(rec.rss_kb)).toBeGreaterThan(0);
		expect(rec.rss_truncated).toBe("false");
		expect(rec.signal).toBe("unknown");
	});

	/* A real spawned child races the detached watcher (mantahostels#2691), which polls
	 * independently and — in every test in this file that waits before
	 * calling `check` — wins the dedup slot first. What actually needs
	 * proving — that a real wall-clock delay before `check` is the ONLY
	 * caller does not leak into elapsed_s — needs no watcher in the race at
	 * all, which only a hand-built dir gives. */
	it("records elapsed_s against the beat's death time, not against whenever check happens to run", async () => {
		const dir = join(root, "late-checked");
		mkdirSync(dir, { recursive: true });
		const launched = Math.floor(Date.now() / 1000) - 600;
		const died = launched + 3;
		writeFileSync(join(dir, "started"), `${launched}\n`);
		writeFileSync(join(dir, "out"), "");
		writeFileSync(join(dir, "beat"), "");
		utimesSync(join(dir, "beat"), died, died);

		/* The buggy computation would add this wait onto elapsed_s; the fix
		 * does not. */
		await sleep(4000);

		check("late-checked");
		const rec = readKillLines().find((l) => l.name === "late-checked");
		expect(rec).toBeDefined();
		expect(Number(rec.elapsed_s)).toBe(died - launched);
	});

	it("sources the death epoch from the beat, and states the heartbeat that bounds it", async () => {
		const before = Math.floor(Date.now() / 1000);
		const child = spawn(SCRIPT, ["run", "epochs", "sleep", KILLED_LIFETIME_S], {
			env: env(),
		});
		await untilPublished("epochs");
		expectMidCommand("epochs", child.pid);
		child.kill("SIGKILL");
		expect((await untilVerdict("epochs")).status).toBe(1);

		const rec = readKillLines().find((l) => l.name === "epochs");
		expect(rec).toBeDefined();
		expect(rec.death_epoch_source).toBe("beat");
		expect(Number(rec.started_epoch)).toBeGreaterThanOrEqual(before);
		expect(Number(rec.death_epoch)).toBeGreaterThanOrEqual(
			Number(rec.started_epoch),
		);
		expect(Number(rec.death_epoch)).toBeLessThan(Math.floor(Date.now() / 1000));
		expect(Number(rec.death_epoch) - Number(rec.started_epoch)).toBe(
			Number(rec.elapsed_s),
		);
		expect(rec.heartbeat_s).toBe(Number(FAST.WFC_BG_HEARTBEAT_S));
	});

	/* The ordering itself, off the real clock: a ticking WFC_BG_NOW puts the
	 * launch a minute ahead of the filesystem's clock and reads later on every
	 * call within the launching process, so a `beat` made by a plain write, or
	 * stamped from a clock read before `started`'s, dates before `started`;
	 * one stamped after cannot (#2674). HEARTBEAT_S outlasts the test, so the
	 * toucher's first re-touch, which restamps `beat` from the filesystem
	 * clock, never comes; `check`'s own clock is pinned past STALE_S. */
	it("never dates a death before its launch, for a run killed before its first re-touch (#2674)", async () => {
		const launched = Math.floor(Date.now() / 1000) + 60;
		const { pid } = spawnDetached(
			["run", "ordered", "sleep", KILLED_LIFETIME_S],
			env({
				WFC_BG_NOW: `${launched}+`,
				WFC_BG_HEARTBEAT_S: "60",
			}),
		);
		try {
			await untilPublished("ordered");
			expectMidCommand("ordered", pid);
			process.kill(-pid, "SIGKILL");
			const got = check("ordered", { WFC_BG_NOW: String(launched + 60) });
			expect(got.status).toBe(1);
			const rec = readKillLines().find((l) => l.name === "ordered");
			expect(rec).toBeDefined();
			expect(Number(rec.started_epoch)).toBeGreaterThan(launched);
			expect(Number(rec.death_epoch)).toBeGreaterThanOrEqual(
				Number(rec.started_epoch),
			);
			expect(Number(rec.elapsed_s)).toBeGreaterThanOrEqual(0);
		} finally {
			for (const watcher of readWatcherPids(runFile("ordered", "token"))) {
				process.kill(Number(watcher), "SIGKILL");
			}
		}
	});

	/* The test above cannot see `check`'s own stale-beat call: the detached
	 * watcher always records first in that shape, and takes the dedup slot.
	 * A hand-built dir with a beat aged past WFC_BG_STALE_S reaches `check`
	 * directly, and its mtime is a value we chose, so the death epoch can be
	 * asserted exactly rather than bounded. */
	it("takes the death epoch from the beat's mtime on check's own stale-beat path", () => {
		const dir = join(root, "stale-by-hand");
		mkdirSync(dir, { recursive: true });
		const launched = Math.floor(Date.now() / 1000) - 600;
		const died = launched + 420;
		writeFileSync(join(dir, "started"), `${launched}\n`);
		writeFileSync(join(dir, "out"), "");
		writeFileSync(join(dir, "beat"), "");
		utimesSync(join(dir, "beat"), died, died);

		check("stale-by-hand");
		const rec = readKillLines().find((l) => l.name === "stale-by-hand");
		expect(rec).toBeDefined();
		expect(rec.reason).toBe("stale-beat");
		expect(rec.death_epoch_source).toBe("beat");
		expect(Number(rec.death_epoch)).toBe(died);
		expect(Number(rec.started_epoch)).toBe(launched);
		expect(Number(rec.elapsed_s)).toBe(died - launched);
	});

	/* Two ways of being wrong that the pair above cannot see on its own: a
	 * death epoch sourced from the clock while claiming the beat, and one
	 * that is empty or zero — `Number("")` is 0, so a finiteness check alone
	 * passes on a field that was never written. */
	it("falls back to the recorder's own clock, saying so, where there was no beat to read", () => {
		const before = Math.floor(Date.now() / 1000);
		const dir = join(root, "no-beat-epochs");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "out"), "");
		check("no-beat-epochs");
		const rec = readKillLines().find((l) => l.name === "no-beat-epochs");
		expect(rec).toBeDefined();
		expect(rec.reason).toBe("before-first-beat");
		expect(rec.death_epoch_source).toBe("clock");
		expect(Number(rec.death_epoch)).toBeGreaterThanOrEqual(before);
		expect(Number(rec.death_epoch)).toBeLessThanOrEqual(
			Math.floor(Date.now() / 1000),
		);
		/* no `started` file either, so both the launch epoch and the elapsed
		 * time say they are unknown rather than guessing */
		expect(rec.started_epoch).toBe("unknown");
		expect(rec.elapsed_s).toBe("unknown");
	});

	it("records 'before-first-beat' as its own reason, distinct from a stale beat", () => {
		const dir = join(root, "no-beat-yet-2");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "out"), "");
		check("no-beat-yet-2");
		const lines = readKillLines();
		expect(lines).toHaveLength(1);
		expect(lines[0].reason).toBe("before-first-beat");
	});

	it("reads the queue state off the command's own '--queue' output", () => {
		const dir = join(root, "queued");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "out"),
			"--queue: a suite is already running; waiting for it\n",
		);
		check("queued");
		const lines = readKillLines();
		expect(lines).toHaveLength(1);
		expect(lines[0].queue_state).toBe("waiting");
	});

	it("reads the gate-timeout escape ('running anyway') as passed, not waiting", () => {
		const dir = join(root, "gate-timeout");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "out"),
			"--queue: a suite is already running; waiting for it\n" +
				"--queue: gate still closed after 300s — running anyway\n",
		);
		check("gate-timeout");
		const lines = readKillLines();
		expect(lines).toHaveLength(1);
		expect(lines[0].queue_state).toBe("passed");
	});

	/* The line is waitForGate's own, so a change to its wording fails here
	 * rather than leaving the refusal read as "waiting" (#2421). */
	it.each([
		["memory-limb", { limb: "memory", mb: 900, rungMb: 3250 }],
		["count-limb", { limb: "count" }],
	])("reads a %s timeout as refused, not waiting", async (limb, denial) => {
		const name = `gate-refused-${limb}`;
		const dir = join(root, name);
		mkdirSync(dir, { recursive: true });
		const said: string[] = [];
		await waitForGate({
			gate: () => denial,
			timeoutMs: 0,
			admit: () => "admitted",
			out: { write: (s: string) => said.push(s) },
		});
		writeFileSync(
			join(dir, "out"),
			`--queue: a suite is already running; waiting for it\n${said.join("")}`,
		);
		check(name);
		const lines = readKillLines();
		expect(lines).toHaveLength(1);
		expect(lines[0].queue_state).toBe("refused");
	});

	it("escapes a quote in the run's own name so the line still parses as JSON", () => {
		const dir = join(root, 'weird"name');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "out"), "");
		check('weird"name');
		const lines = readKillLines();
		expect(lines).toHaveLength(1);
		expect(lines[0].name).toBe('weird"name');
	});

	it("does not duplicate the record when the same killed run is checked twice", async () => {
		const child = spawn(
			SCRIPT,
			["run", "checked-twice", "sleep", KILLED_LIFETIME_S],
			{
				env: env(),
			},
		);
		await untilPublished("checked-twice");
		expectMidCommand("checked-twice", child.pid);
		child.kill("SIGKILL");
		expect((await untilVerdict("checked-twice")).status).toBe(1);

		check("checked-twice");
		const lines = readKillLines().filter((l) => l.name === "checked-twice");
		expect(lines).toHaveLength(1);
	});
});

describe("the detached watcher (mantahostels#2691) — a kill recorded with no `check` ever called", () => {
	/* A kill line carries the `started` of whichever run's directory the
	 * recorder read, so this is what tells a kill of the OLD run from one
	 * falsely recorded against the run that replaced it. */
	function startedEpoch(name: string) {
		return runFile(name, "started");
	}

	const watcherAlive = (token: string) => readWatcherPids(token).length > 0;

	/* The kill lines for `name`, once the watcher has written one. */
	async function killedOnce(name: string) {
		const readOwnKillLines = () =>
			readKillLines().filter((l) => l.name === name);
		await waitFor(`${name}'s kill record`, () => readOwnKillLines().length > 0);
		return readOwnKillLines();
	}

	/* The publish waits for the watcher (#2110), but only up to
	 * WATCH_READY_S, so a kill on publish alone, or after a fixed sleep a
	 * loaded machine overruns, can still land with no watcher (#2106). */
	async function untilWatched(name: string) {
		await untilPublished(name);
		const token = runFile(name, "token");
		await waitFor(`${name}'s watcher to start`, () => watcherAlive(token));
		return token;
	}

	it("appends the kill record on its own — no `check` call anywhere in this test", async () => {
		const child = spawn(
			SCRIPT,
			["run", "unwatched", "sleep", KILLED_LIFETIME_S],
			{
				env: env(),
			},
		);
		await untilWatched("unwatched");
		expectMidCommand("unwatched", child.pid);
		child.kill("SIGKILL");

		const lines = await killedOnce("unwatched");
		expect(lines).toHaveLength(1);
		expect(lines[0].reason).toBe("stale-beat");
		expect(lines[0].signal).toBe("unknown");
	});

	it("does not poison a reused name's new run when the old run's watcher outlives it", async ({
		skip,
	}) => {
		/* The old watcher polls $dir by PATH, not by the run it was launched
		 * for. `run <name>` on a name still alive republishes $dir out from
		 * under it (mantahostels#2691) — without the run-token guard in cmd_watch,
		 * the old watcher would eventually see its own (by-then-dead) parent
		 * gone, find the NEW run's dir with no `status`, and record a false
		 * kill for a run that never died. */
		const first = spawn(SCRIPT, ["run", "reused", "sleep", KILLED_LIFETIME_S], {
			env: env(),
		});
		await untilWatched("reused");
		const firstStarted = startedEpoch("reused");
		expectMidCommand("reused", first.pid);
		first.kill("SIGKILL");

		/* Republish immediately with a run that stays alive for the whole
		 * window below — no `status` file for the old watcher's inner
		 * check (cmd_watch's second `status` test) to catch instead, so this actually
		 * exercises the run-token guard and not the belt-and-braces
		 * one next to it. */
		const go = join(root, "go");
		const firstToken = runFile("reused", "token");
		const second = spawn(
			SCRIPT,
			["run", "reused", "sh", "-c", runsUntilFile(go)],
			{
				env: env(),
			},
		);
		await waitFor(
			"the relaunch to republish",
			republished("reused", firstToken),
		);

		/* Time is what is under test: the guard holds only if nothing is
		 * recorded across several of the old watcher's heartbeats, and an
		 * absence has no event to wait on. */
		await sleep(4000);

		/* Filtering by NAME alone read the old run's own kill — perfectly
		 * true, and recorded whenever that watcher woke in the gap between
		 * the SIGKILL and the republish — as the false one this case hunts
		 * (mantahostels#3147). */
		const secondStarted = startedEpoch("reused");
		if (secondStarted === "" || secondStarted === firstStarted) {
			writeFileSync(go, ""); // skipping leaves nobody to await its exit
			skip(); // the two launches shared a second: the case below owns that
		}
		const lines = readKillLines().filter(
			(l) => l.name === "reused" && l.started_epoch === secondStarted,
		);
		expect(lines).toHaveLength(0);
		expect(check("reused").status).toBe(2); // RUNNING

		const exited = new Promise((resolve) => second.on("exit", resolve));
		writeFileSync(go, "");
		await exited;
	});

	it("tells the two runs apart when the relaunch shares the old run's launch second (mantahostels#3147)", async () => {
		/* `started` is whole seconds: relaunch inside the same second and a
		 * guard comparing it read the NEW run's directory as the one it was
		 * launched for, and recorded a kill against a run that was alive.
		 *
		 * WFC_BG_NOW pins the clock, so the two `started` files match without
		 * catching a second boundary (#1337). And the relaunch publishes BEFORE the
		 * kill: killed first, the old watcher could wake before the
		 * republish and record the old run's own true kill, which shares
		 * this name and `started` and so reads as the false one. Residual:
		 * the pin also freezes the watcher's WATCH_CEILING_S deadline, which
		 * this case never needs. */
		const pinnedClockEnv = env({ WFC_BG_NOW: "1700000000" });

		const { pid: firstPid } = spawnDetached(
			["run", "samesec", "sh", "-c", `echo up; sleep ${KILLED_LIFETIME_S}`],
			pinnedClockEnv,
		);
		const go = join(root, "go");
		let second: ReturnType<typeof spawn> | undefined;
		try {
			await untilPrinted("samesec", "up");
			const firstToken = await untilWatched("samesec");
			const firstStarted = startedEpoch("samesec");

			second = spawn(
				SCRIPT,
				["run", "samesec", "sh", "-c", runsUntilFile(go)],
				{ env: pinnedClockEnv },
			);
			await waitFor(
				"the relaunch to republish",
				republished("samesec", firstToken),
			);
			expect(startedEpoch("samesec")).toBe(firstStarted);
			expectMidCommand("samesec", firstPid);
			process.kill(-firstPid, "SIGKILL");

			/* Gone means it reached the run-token guard. The relaunch must still
			 * be running then, or the watcher left on its `status` file instead
			 * and the guard went untested. */
			await waitFor("the old watcher to exit", () => !watcherAlive(firstToken));
			expect(existsSync(join(root, "samesec", "status"))).toBe(false);
			expect(readKillLines().filter((l) => l.name === "samesec")).toHaveLength(
				0,
			);
		} finally {
			try {
				process.kill(-firstPid, "SIGKILL");
			} catch {
				// already killed above
			}
			writeFileSync(go, "");
		}

		const relaunch = second;
		if (relaunch && relaunch.exitCode === null)
			await new Promise((resolve) => relaunch.on("exit", resolve));
	});

	it("records nothing against a relaunch that republishes between the old watcher's token check and its record (#1352)", async () => {
		/* WFC_BG_WATCH_GATE holds the old watcher in that gap, so the republish
		 * lands there every time. Only the
		 * old run carries the gate; the relaunch's own watcher must record its
		 * kill unhindered, which is the dedup slot the race used to take. */
		const gate = join(root, "gate");
		const { pid: firstPid } = spawnDetached(
			["run", "gapped", "sleep", KILLED_LIFETIME_S],
			env({ WFC_BG_WATCH_GATE: gate }),
		);
		let secondPid: number | undefined;
		try {
			const firstToken = await untilWatched("gapped");
			expectMidCommand("gapped", firstPid);
			process.kill(-firstPid, "SIGKILL");
			await waitFor("the old watcher to pass its token check", () =>
				existsSync(`${gate}.waiting`),
			);

			secondPid = spawnDetached(
				["run", "gapped", "sleep", KILLED_LIFETIME_S],
				env(),
			).pid;
			await waitFor(
				"the relaunch to republish",
				republished("gapped", firstToken),
			);
			const secondStarted = startedEpoch("gapped");
			writeFileSync(gate, "");
			await waitFor("the old watcher to exit", () => !watcherAlive(firstToken));

			expect(readKillLines().filter((l) => l.name === "gapped")).toHaveLength(
				0,
			);
			expect(existsSync(join(root, "gapped", ".kill-recorded"))).toBe(false);

			await untilWatched("gapped");
			expectMidCommand("gapped", secondPid);
			process.kill(-secondPid, "SIGKILL");
			await waitFor("the relaunch's own kill to be recorded", () =>
				readKillLines().some((l) => l.name === "gapped"),
			);
			const lines = readKillLines().filter((l) => l.name === "gapped");
			expect(lines).toHaveLength(1);
			expect(lines[0].started_epoch).toBe(secondStarted);
		} finally {
			for (const pid of [firstPid, secondPid]) {
				try {
					if (pid !== undefined) process.kill(-pid, "SIGKILL");
				} catch {
					// already killed above
				}
			}
		}
	});

	it("records SIGTERM as the signal, distinct from an uncatchable SIGKILL's 'unknown'", async () => {
		/* TERM must reach the wrapper AND the wrapped `sleep`, not the wrapper
		 * alone: bash defers a trap while blocked in a foreground wait() for
		 * an external command, running it only once that command returns
		 * (cmd_run's own toucher comment has why the command stays
		 * foreground). A group-wide signal — the production shape the
		 * file's header describes — hits both at once. */
		const { pid } = spawnDetached(
			["run", "termed", "sh", "-c", `echo up; sleep ${KILLED_LIFETIME_S}`],
			env(),
		);
		await untilWatched("termed");
		await untilPrinted("termed", "up");
		expectMidCommand("termed", pid);
		process.kill(-pid, "SIGTERM");

		const lines = await killedOnce("termed");
		expect(lines).toHaveLength(1);
		expect(lines[0].signal).toBe("TERM");
	});

	it("reports DONE, not KILLED, when TERM reaches the wrapper alone and the command finishes before the deferred trap runs (mantahostels#2747)", async () => {
		/* No `detached`/negative-pid kill here — the point of this test is a
		 * TERM that reaches ONLY this process, never the wrapped `sleep`,
		 * which is exactly the shape that stays pending in bash until the
		 * foreground wait() unblocks on its own. */
		const go = join(root, "go");
		const child = spawn(
			SCRIPT,
			["run", "aloneterm", "sh", "-c", `echo up; ${runsUntilFile(go)}`],
			{ env: env() },
		);
		if (child.pid === undefined) throw new Error("spawn did not return a pid");
		await untilPrinted("aloneterm", "up");
		const done = new Promise<{ status: number | null }>((resolve) => {
			child.on("close", (status) => resolve({ status }));
		});
		process.kill(child.pid, "SIGTERM");
		writeFileSync(go, "");
		await done;

		const got = check("aloneterm");
		expect(got.stdout).toContain("DONE exit=0");
		expect(existsSync(join(root, "aloneterm", "status"))).toBe(true);
		expect(existsSync(join(root, "aloneterm", ".signal"))).toBe(false);

		expect(readKillLines().filter((l) => l.name === "aloneterm")).toHaveLength(
			0,
		);
	});

	it("records SIGHUP as the signal, same as the SIGTERM shape above (mantahostels#2749)", async () => {
		const { pid } = spawnDetached(
			["run", "hupped", "sh", "-c", `echo up; sleep ${KILLED_LIFETIME_S}`],
			env(),
		);
		await untilWatched("hupped");
		await untilPrinted("hupped", "up");
		expectMidCommand("hupped", pid);
		process.kill(-pid, "SIGHUP");

		const lines = await killedOnce("hupped");
		expect(lines).toHaveLength(1);
		expect(lines[0].signal).toBe("HUP");
	});

	it("reports DONE with no kill record when a whole-tree TERM is caught by the wrapped command, which exits by choice (mantahostels#2749)", async () => {
		/* The documented gap itself (mantahostels#2749): a wrapped command that installs
		 * its own TERM trap and exits 0 rather than dying by TERM's default
		 * disposition reads as DONE, because on_signal's only discriminator is
		 * the wrapped command's exit code against 128+signum. */
		const { child, pid } = spawnDetached(
			[
				"run",
				"caughtterm",
				"sh",
				"-c",
				`trap 'exit 0' TERM; echo trapped; sleep ${KILLED_LIFETIME_S}`,
			],
			env(),
		);
		await untilPrinted("caughtterm", "trapped");
		const done = new Promise<{ status: number | null }>((resolve) => {
			child.on("close", (status) => resolve({ status }));
		});
		expectMidCommand("caughtterm", pid);
		process.kill(-pid, "SIGTERM");
		await done;

		const got = check("caughtterm");
		expect(got.stdout).toContain("DONE exit=0");
		expect(got.status).toBe(0);
		expect(existsSync(join(root, "caughtterm", ".signal"))).toBe(false);
		expect(readKillLines().filter((l) => l.name === "caughtterm")).toHaveLength(
			0,
		);
	});

	it("reads a whole-tree TERM as KILLED when the trapping command follows the 128+signum convention (mantahostels#2749)", async () => {
		/* The convention that keeps scripts/run-vitest.js's own TERM/HUP trap
		 * from hitting the gap above: exit at exactly 128+signum instead of
		 * choosing an unrelated code, so on_signal's discriminator reads it as
		 * a real kill. */
		const { pid } = spawnDetached(
			[
				"run",
				"conventional",
				"sh",
				"-c",
				`trap 'exit 143' TERM; echo trapped; sleep ${KILLED_LIFETIME_S}`,
			],
			env(),
		);
		await untilWatched("conventional");
		await untilPrinted("conventional", "trapped");
		expectMidCommand("conventional", pid);
		process.kill(-pid, "SIGTERM");

		const lines = await killedOnce("conventional");
		expect(lines).toHaveLength(1);
		expect(lines[0].signal).toBe("TERM");
		expect(existsSync(join(root, "conventional", ".signal"))).toBe(true);
		expect(existsSync(join(root, "conventional", "status"))).toBe(false);

		/* The watcher's own liveness poll can see the wrapper gone well before
		 * `check`'s independent beat-staleness reading would. */
		const got = await untilVerdict("conventional");
		expect(got.stdout).toContain("KILLED");
		expect(got.stdout).not.toContain("DONE");
	});

	it("records a kill landing the moment the run publishes, its watcher's fork held late (#2110)", async () => {
		/* Crosses the real clock: the kill is a real group SIGKILL. The 1 s
		 * hold is #2106's reproduction, far longer than the kill takes to land
		 * after the publish. */
		const { pid } = spawnDetached(
			["run", "late", "sleep", KILLED_LIFETIME_S],
			env({ WFC_BG_WATCH_FORK_DELAY_S: "1" }),
		);
		await waitFor(
			"late's run to publish",
			() => runFile("late", "token") !== "",
		);
		expectMidCommand("late", pid);
		process.kill(-pid, "SIGKILL");

		await waitFor("late's kill record", () =>
			readKillLines().some((l) => l.name === "late"),
		);
		const kills = readKillLines().filter((l) => l.name === "late");
		expect(kills).toHaveLength(1);
		/* The launch line is written before the publish (#2276), so the kill
		 * has its launch. */
		expect(
			readJsonLines(join(root, "launches.jsonl"))
				.filter((l) => l.name === "late")
				.map((l) => l.started_epoch),
		).toEqual([kills[0].started_epoch]);
	});

	it("publishes without its watcher once WATCH_READY_S runs out, the run itself unaffected, its launch line watcher_ready false (#2110, #2276)", () => {
		/* Crosses the real clock: the ceiling under test is the shipped
		 * wall-clock wait. */
		const got = run(["run", "unready", "true"], {
			WFC_BG_WATCH_FORK_DELAY_S: "1",
			WFC_BG_WATCH_READY_S: "0.2",
		});
		expect(got.status).toBe(0);
		expect(runFile("unready", "status")).toBe("exit=0");
		expect(
			readdirSync(join(root, "unready")).filter((f) =>
				f.startsWith(".watching"),
			),
		).toEqual([]);
		expect(readJsonLines(join(root, "launches.jsonl"))[0].watcher_ready).toBe(
			false,
		);
	});
});

describe("the kill log's default location (mantahostels#2691) — outside the job-scoped run_root()", () => {
	/* kill_log_path() asks git about SCRIPT_DIR — resolved from the running
	 * script's own path, not the caller's cwd — so redirecting which repo it
	 * asks about means running a COPY of bg-run.sh from inside a throwaway
	 * repo, never the real checkout (see env()'s own comment above for why
	 * it must not touch the real log). */
	let repo: string;
	let script: string;

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "bg-run-repo-test-"));
		execFileSync("git", ["init", "--quiet"], { cwd: repo });
		mkdirSync(join(repo, "scripts"));
		script = join(repo, "scripts", "bg-run.sh");
		copyFileSync(SCRIPT, script);
	});

	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	it("writes to the repo's git common dir, not run_root(), when WFC_BG_KILL_LOG is unset", () => {
		const runDir = join(repo, "run");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "out"), "");
		const { status, stdout } = spawnSync(script, ["check", "run"], {
			env: { ...process.env, WFC_BG_ROOT: repo },
			cwd: repo,
			encoding: "utf8",
			...BOUNDED,
		});
		expect(status).toBe(1);
		expect(stdout).toContain("KILLED before the first beat");
		const gitCommon = execFileSync(
			"git",
			["rev-parse", "--path-format=absolute", "--git-common-dir"],
			{ cwd: repo, encoding: "utf8" },
		).trim();
		expect(existsSync(join(gitCommon, "bg-kills.jsonl"))).toBe(true);
		expect(existsSync(join(repo, "kills.jsonl"))).toBe(false);
	});

	it("puts the launch log beside the kill log in the git common dir (mantahostels#2763)", () => {
		spawnSync(script, ["run", "logged", "sh", "-c", "exit 0"], {
			env: { ...process.env, WFC_BG_ROOT: repo },
			cwd: repo,
			encoding: "utf8",
			...BOUNDED,
		});
		const gitCommon = execFileSync(
			"git",
			["rev-parse", "--path-format=absolute", "--git-common-dir"],
			{ cwd: repo, encoding: "utf8" },
		).trim();
		expect(existsSync(join(gitCommon, "bg-launches.jsonl"))).toBe(true);
		expect(existsSync(join(repo, "launches.jsonl"))).toBe(false);
	});

	it("falls back to run_root()/kills.jsonl when git cannot answer at all", () => {
		/* Shadows `git` alone, not the whole PATH — the script still needs
		 * date/sed/grep/awk/mv, so blanking PATH entirely would break the
		 * run rather than isolate kill_log_path()'s fail-open branch. A decoy
		 * `git` ahead of the real one on PATH exits 1 unconditionally,
		 * matching what an absent binary or an unreadable common dir looks
		 * like to `markerPath()`'s precedent in sweep-budget.js. */
		const fakeBin = join(repo, "fakebin");
		mkdirSync(fakeBin);
		writeFileSync(join(fakeBin, "git"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

		const runDir = join(repo, "run");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "out"), "");
		const { status, stdout } = spawnSync(script, ["check", "run"], {
			env: {
				...process.env,
				WFC_BG_ROOT: repo,
				PATH: `${fakeBin}:${process.env.PATH}`,
			},
			cwd: repo,
			encoding: "utf8",
			...BOUNDED,
		});
		expect(status).toBe(1);
		expect(stdout).toContain("KILLED before the first beat");
		expect(existsSync(join(repo, "kills.jsonl"))).toBe(true);
	});
});

describe("the launch log (mantahostels#2763) — the kill log's denominator", () => {
	it("appends one line per run, so survivals are counted and not just kills", () => {
		run(["run", "one", "sh", "-c", "exit 0"]);
		run(["run", "two", "sh", "-c", "exit 0"]);
		const got = readJsonLines(join(root, "launches.jsonl"));
		expect(got.map((l) => l.name)).toEqual(["one", "two"]);
		expect(got.map((l) => l.watcher_ready)).toEqual([true, true]);
	});

	it("carries a started_epoch matching the run's own, so a kill line joins to it", () => {
		run(["run", "joined", "sh", "-c", "exit 0"]);
		const [launch] = readJsonLines(join(root, "launches.jsonl"));
		const started = readFileSync(
			join(root, "joined", "started"),
			"utf8",
		).trim();
		expect(launch.started_epoch).toBe(started);
	});

	it("labels the arm: the escape variable as this process saw it", () => {
		run(["run", "armed", "sh", "-c", "exit 0"], {
			CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP: "1",
		});
		expect(readJsonLines(join(root, "launches.jsonl"))[0].reap_escape).toBe(
			"1",
		);
	});

	it("tells an absent escape from one set to the empty string — a third arm", () => {
		runWithout(
			["CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP"],
			["run", "bare", "sh", "-c", "exit 0"],
		);
		run(["run", "empty", "sh", "-c", "exit 0"], {
			CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP: "",
		});
		const got = readJsonLines(join(root, "launches.jsonl"));
		expect(got.find((l) => l.name === "bare").reap_escape).toBe(null);
		expect(got.find((l) => l.name === "empty").reap_escape).toBe("");
	});

	it("escapes a run name that would otherwise break the JSON", () => {
		run(["run", 'q"b\\s', "sh", "-c", "exit 0"]);
		expect(readJsonLines(join(root, "launches.jsonl"))[0].name).toBe('q"b\\s');
	});

	it("escapes an escape-variable value that would otherwise break the JSON", () => {
		run(["run", "odd", "sh", "-c", "exit 0"], {
			CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP: 'a"b\\c',
		});
		expect(readJsonLines(join(root, "launches.jsonl"))[0].reap_escape).toBe(
			'a"b\\c',
		);
	});

	it("escapes a newline, which would otherwise split one record across two lines", () => {
		run(["run", "nl", "sh", "-c", "exit 0"], {
			CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP: "one\ntwo",
		});
		const got = readJsonLines(join(root, "launches.jsonl"));
		expect(got).toHaveLength(1);
		expect(got[0].reap_escape).toBe("one\ntwo");
	});

	it("records the machine's available memory in MB, and unknown where it cannot be read", () => {
		const meminfo = join(root, "meminfo");
		writeFileSync(meminfo, "MemTotal: 9999 kB\nMemAvailable: 3145728 kB\n");
		expect(
			run(["run", "read", "sh", "-c", "exit 0"], { WFC_BG_MEMINFO: meminfo })
				.status,
		).toBe(0);
		expect(
			run(["run", "unread", "sh", "-c", "exit 0"], {
				WFC_BG_MEMINFO: join(root, "no-meminfo"),
			}).status,
		).toBe(0);
		const got = readJsonLines(join(root, "launches.jsonl"));
		expect(got.find((l) => l.name === "read").mem_available_mb).toBe("3072");
		expect(got.find((l) => l.name === "unread").mem_available_mb).toBe(
			"unknown",
		);
	});

	it("records job_dir_set true under a background job and false without one", () => {
		run(["run", "bg", "sh", "-c", "exit 0"], { CLAUDE_JOB_DIR: root });
		runWithout(["CLAUDE_JOB_DIR"], ["run", "fg", "sh", "-c", "exit 0"]);
		const got = readJsonLines(join(root, "launches.jsonl"));
		expect(got.find((l) => l.name === "bg").job_dir_set).toBe(true);
		expect(got.find((l) => l.name === "fg").job_dir_set).toBe(false);
	});

	it("still runs the command when the log genuinely cannot be written", () => {
		/* record_launch()'s own `mkdir -p` creates a missing directory, so an
		 * absent path is NOT unwritable. A regular file standing where the
		 * parent directory must be is: both the mkdir and the append fail. */
		const blocker = join(root, "blocker");
		writeFileSync(blocker, "");
		const ran = run(["run", "unlogged", "sh", "-c", "exit 3"], {
			WFC_BG_LAUNCH_LOG: join(blocker, "launches.jsonl"),
		});
		expect(existsSync(join(blocker, "launches.jsonl"))).toBe(false);
		expect(ran.status).toBe(3);
		expect(ran.stdout).toBe("");
		expect(check("unlogged").stdout).toContain("DONE exit=3");
	});
});

describe("the suite ceiling's backstop (#2704)", () => {
	const { DEADLINE_ENV, monotonicMs } = require("./lib/suite-ceiling.js");

	/* The clock the runners write the deadline on, in whole seconds. */
	const monoS = () => Math.floor(monotonicMs() / 1000);

	/* A runner that wedged past its deadline: it starts a plain child and a
	 * group outside its own tree, as a SIGKILLed runner's orphaned vitest is,
	 * writes `<deadline> <pgid>` with the deadline `ago` seconds past, prints
	 * its report, then waits. */
	const wedged = (name: string, ago: number) => [
		"run",
		name,
		"sh",
		"-c",
		[
			`setsid --fork sh -c 'echo $$ > "${root}/group"; exec sleep ${KILLED_LIFETIME_S}'`,
			`sleep ${KILLED_LIFETIME_S} & echo $! > '${root}/child'`,
			shWaitFor(`[ -s '${root}/group' ]`),
			`echo "${monoS() - ago} $(cat '${root}/group')" > "$${DEADLINE_ENV}"`,
			"echo 'SUITE CEILING — the runner report'",
			"wait",
		].join("; "),
	];

	const readPid = (file: string) =>
		Number(readFileSync(join(root, file), "utf8"));

	/* The watcher polls each heartbeat, so these cross the real clock. */
	it("kills the named group and the wrapped tree, and check reads a finished, failed ceiling kill", async () => {
		const child = spawn(SCRIPT, wedged("wedged", 1), {
			env: env({ WFC_BG_CEILING_GRACE_S: "0" }),
		});
		try {
			await untilPrinted("wedged", "runner report");
			await waitFor(
				"the run's status",
				() => runFile("wedged", "status") !== "",
			);
		} finally {
			child.kill("SIGKILL");
		}

		for (const got of [check("wedged"), run(["wait", "wedged", "5"])]) {
			expect(got.status).toBe(0);
			expect(got.stdout).toMatch(
				/^DONE exit=137 ceiling-kill: bg-run killed it 0s past its suite deadline$/m,
			);
			expect(got.stdout).toContain("SUITE CEILING — the runner report");
		}
		await waitFor(
			"the group and the tree to die",
			() => isDead(readPid("group")) && isDead(readPid("child")),
		);
		expect(
			readJsonLines(join(root, "kills.jsonl")).map((l) => l.reason),
		).toEqual(["ceiling"]);
	});

	it("spares a group whose leader started before the launch, a recycled pid", async () => {
		/* Started 2 s before the launch: past the one second the start-time
		 * check allows for rounding. */
		const elder = spawn("sleep", [KILLED_LIFETIME_S], {
			detached: true,
			stdio: "ignore",
		});
		const elderPid = elder.pid as number;
		try {
			await sleep(2000);
			const child = spawn(
				SCRIPT,
				[
					"run",
					"recycled",
					"sh",
					"-c",
					`echo "${monoS() - 1} ${elderPid}" > "$${DEADLINE_ENV}"; sleep ${KILLED_LIFETIME_S}`,
				],
				{ env: env({ WFC_BG_CEILING_GRACE_S: "0" }) },
			);
			try {
				await waitFor(
					"the run's status",
					() => runFile("recycled", "status") !== "",
				);
			} finally {
				child.kill("SIGKILL");
			}

			expect(isDead(elderPid)).toBe(false);
		} finally {
			process.kill(-elderPid, "SIGKILL");
		}
	});

	it("holds the grace at 60 s when the environment asks for more", async () => {
		const child = spawn(SCRIPT, wedged("stretched", 61), {
			env: env({ WFC_BG_CEILING_GRACE_S: "999" }),
		});
		try {
			await waitFor(
				"the run's status",
				() => runFile("stretched", "status") !== "",
			);
		} finally {
			child.kill("SIGKILL");
		}

		expect(check("stretched").stdout).toContain("killed it 60s past");
	});

	it("never kills a run whose deadline the wall clock has passed but the monotonic clock has not (#2886)", () => {
		/* A host suspend steps the wall clock forward on resume while no
		 * monotonic time passes: the wall clock is pinned a day on, the
		 * monotonic one a second short of the deadline. 3 s is three of FAST's
		 * 1 s heartbeats, as below. */
		const got = run(
			[
				"run",
				"resumed",
				"sh",
				"-c",
				`echo "1001 $$" > "$${DEADLINE_ENV}"; sleep 3; echo finished`,
			],
			{
				WFC_BG_CEILING_GRACE_S: "0",
				WFC_BG_MONO: "1000",
				WFC_BG_NOW: String(Math.floor(Date.now() / 1000) + 86_400),
			},
		);

		expect(got.status).toBe(0);
		expect(check("resumed").stdout).toMatch(/^DONE exit=0$/m);
		expect(existsSync(join(root, "kills.jsonl"))).toBe(false);
	});

	it("never kills a command that writes no deadline file", () => {
		/* 3 s is three of FAST's 1 s heartbeats: three watcher passes, any of
		 * which would kill a run it read as due. */
		const got = run(["run", "plain", "sh", "-c", "sleep 3; echo finished"], {
			WFC_BG_CEILING_GRACE_S: "0",
		});

		expect(got.status).toBe(0);
		expect(check("plain").stdout).toMatch(/^DONE exit=0$/m);
		expect(existsSync(join(root, "kills.jsonl"))).toBe(false);
	});
});

describe("what it refuses to answer", () => {
	it("refuses a name it has never run, rather than calling it killed", () => {
		const got = check("never-ran");
		expect(got.status).toBe(3);
		expect(got.stderr).toContain("no run named");
	});

	it("refuses an unreadable status file rather than reporting a blank code", () => {
		run(["run", "corrupt", "sh", "-c", "exit 0"]);
		writeFileSync(join(root, "corrupt", "status"), "garbage\n");
		const got = check("corrupt");
		expect(got.status).toBe(3);
		expect(got.stderr).toContain("unreadable");
	});

	it("clears a previous run's status, so a re-run is not read as finished", async () => {
		run(["run", "reused", "sh", "-c", "exit 0"]);
		expect(check("reused").stdout).toContain("DONE");
		const oldToken = runFile("reused", "token");

		const child = spawn(SCRIPT, ["run", "reused", "sleep", KILLED_LIFETIME_S], {
			env: env(),
		});
		await waitFor("the re-run to publish", republished("reused", oldToken));
		expect(check("reused").stdout).toContain("RUNNING");
		child.kill("SIGKILL");
	});
});

/*
 * The root a run was launched into is recorded and read back (mantahostels#2916).
 *
 * run_root() is resolved twice — once by `run`, once by every later `check` —
 * from environment the script does not own. When the two disagree the run was
 * reported `no run named <x>`, which is indistinguishable from never having
 * launched it.
 */
describe("a run whose root moved between launch and check", () => {
	it("is found under the root it was launched into, not the one check resolves", () => {
		const launchRoot = join(root, "launch-root");
		run(["run", "moved", "sh", "-c", "exit 7"], {
			WFC_BG_ROOT: launchRoot,
		});
		/* No WFC_BG_ROOT override, so this check resolves `root` — a
		 * different directory, which holds no run of that name. */
		const got = check("moved");
		expect(got.stderr).not.toContain("no run named");
		expect(got.stdout).toContain("DONE exit=7");
	});

	it("gives `wait` the same, not just `check`", () => {
		const launchRoot = join(root, "launch-root-wait");
		run(["run", "moved-wait", "sh", "-c", "exit 0"], {
			WFC_BG_ROOT: launchRoot,
		});
		const got = run(["wait", "moved-wait", "3"]);
		expect(got.stderr).not.toContain("no run named");
		expect(parseFirstLine(got.stdout)).toContain("DONE exit=0");
	});

	it("prefers a run in the resolved root over the pinned one", () => {
		/* Same name, two roots, and only the old one carries a launch line —
		 * so the two lookups genuinely disagree and the ordering is
		 * observable. A directory in the resolved root with no launch line of
		 * its own is what a lost or unwritable log leaves behind. */
		run(["run", "twice", "sh", "-c", "exit 7"], {
			WFC_BG_ROOT: join(root, "old-root"),
		});
		const live = join(root, "twice");
		mkdirSync(live, { recursive: true });
		writeFileSync(join(live, "beat"), "");
		writeFileSync(join(live, "out"), "");
		writeFileSync(join(live, "status"), "exit=0\n");
		expect(check("twice").stdout).toContain("DONE exit=0");
	});

	it("records the root it launched into, on every launch", () => {
		const other = join(root, "other-root");
		run(["run", "logged", "sh", "-c", "exit 0"]);
		run(["run", "logged-elsewhere", "sh", "-c", "exit 0"], {
			WFC_BG_ROOT: other,
		});
		const got = readJsonLines(join(root, "launches.jsonl"));
		expect(got.find((l) => l.name === "logged").run_root).toBe(root);
		expect(got.find((l) => l.name === "logged-elsewhere").run_root).toBe(other);
	});

	it("reads the launch line for THIS name, not merely the newest one", () => {
		/* Two names, two roots, and a stale directory of the first name
		 * sitting in the second name's root. A lookup that took the last line
		 * in the log rather than the last line FOR THIS NAME would answer out
		 * of `late-root` and report exit=1. */
		run(["run", "wanted", "sh", "-c", "exit 5"], {
			WFC_BG_ROOT: join(root, "early-root"),
		});
		const lateRoot = join(root, "late-root");
		run(["run", "unwanted", "sh", "-c", "exit 1"], {
			WFC_BG_ROOT: lateRoot,
		});
		const decoy = join(lateRoot, "wanted");
		mkdirSync(decoy, { recursive: true });
		writeFileSync(join(decoy, "beat"), "");
		writeFileSync(join(decoy, "out"), "");
		writeFileSync(join(decoy, "status"), "exit=1\n");

		expect(check("wanted").stdout).toContain("DONE exit=5");
	});

	it("takes the newest launch line when one name carries several", () => {
		/* `run <name>` on a live name republishes the directory, so a name can
		 * appear more than once in the log and the newest is the one a check
		 * means. The older root keeps a directory, so a lookup taking the
		 * FIRST matching line would answer exit=5 out of it. */
		run(["run", "twice-pinned", "sh", "-c", "exit 5"], {
			WFC_BG_ROOT: join(root, "first-root"),
		});
		run(["run", "twice-pinned", "sh", "-c", "exit 6"], {
			WFC_BG_ROOT: join(root, "second-root"),
		});
		expect(check("twice-pinned").stdout).toContain("DONE exit=6");
	});

	it("says the launch line's root is gone too, rather than just 'no run'", () => {
		/* A job dir dies with its job (mantahostels#2691), so a pinned root can vanish.
		 * That is a different story from a name never launched, and the
		 * message has to tell them apart. */
		const launchRoot = join(root, "doomed-root");
		run(["run", "vanished", "sh", "-c", "exit 0"], {
			WFC_BG_ROOT: launchRoot,
		});
		rmSync(join(launchRoot, "vanished"), { recursive: true, force: true });
		const got = check("vanished", {
			WFC_BG_MISSING_S: "0.4",
			WFC_BG_MISSING_POLL_S: "0.05",
		});
		expect(got.status).toBe(3);
		expect(got.stderr).toContain("gone too");
		expect(got.stderr).toContain(join(launchRoot, "vanished"));
	});

	it("re-resolves on every poll, so a directory landing late in the pinned root is found", () => {
		/* The retry window exists for a directory that has not been published
		 * yet. A lookup resolved once, before the loop, would still be
		 * pointing at the fresh root when the pinned one fills. */
		const launchRoot = join(root, "late-pinned-root");
		run(["run", "late", "sh", "-c", "exit 0"], {
			WFC_BG_ROOT: launchRoot,
		});
		rmSync(join(launchRoot, "late"), { recursive: true, force: true });
		createDirLate(join(launchRoot, "late"), true);
		const got = check("late", WIDE_MISSING);
		expect(got.stderr).not.toContain("no run named");
		expect(got.stdout).toContain("DONE exit=0");
	});

	it("still refuses a name no launch line names either", () => {
		run(["run", "elsewhere", "sh", "-c", "exit 0"], {
			WFC_BG_ROOT: join(root, "some-root"),
		});
		const got = check("not-that-one");
		expect(got.status).toBe(3);
		expect(got.stderr).toContain("no run named");
	});
});
