// @vitest-environment node
/*
 * bg-run-watcher.test.ts — scripts/bg-run.sh's detached watcher (mantahostels#2691),
 * the kill log's default location, the launch log (mantahostels#2763), the suite
 * ceiling's backstop (#2704) and a run whose root moved between launch and
 * check. Split from bg-run.test.ts, whose header says what the wrapper sells
 * and why a loosened case costs (#2413).
 *
 * Over the run-cost budget (base §X8 (5)) by inheritance: its cases moved
 * unchanged from bg-run.test.ts, whose cost was pre-existing (#2413).
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	BOUNDED,
	bgRunRoot,
	check,
	createDirLate,
	env,
	expectMidCommand,
	KILLED_LIFETIME_S,
	parseFirstLine,
	readJsonLines,
	readKillLines,
	readWatcherPids,
	republished,
	root,
	run,
	runFile,
	runsUntilFile,
	runWithout,
	SCRIPT,
	shWaitFor,
	sleep,
	spawnDetached,
	THREE_BEATS_S,
	untilPrinted,
	untilPublished,
	untilVerdict,
	WIDE_MISSING,
	waitFor,
} from "./lib/bg-run-testkit";
import { isDead } from "./lib/process-fixture";

bgRunRoot();

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
		 * monotonic one a second short of the deadline. */
		const got = run(
			[
				"run",
				"resumed",
				"sh",
				"-c",
				`echo "1001 $$" > "$${DEADLINE_ENV}"; sleep ${THREE_BEATS_S}; echo finished`,
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

	it("logs once, never per poll, when the monotonic clock will not read (#3160)", () => {
		/* A deadline long past, but no monotonic reading to compare it with.
		 * The poll log counts the failed reads, so the single line is shown
		 * to have outlived at least two of them. */
		const got = run(
			[
				"run",
				"clockless",
				"sh",
				"-c",
				`echo "1 $$" > "$${DEADLINE_ENV}"; sleep ${THREE_BEATS_S}; echo finished`,
			],
			{ WFC_BG_CEILING_GRACE_S: "0", WFC_BG_MONO: "unreadable" },
		);

		expect(got.status).toBe(0);
		const out = check("clockless").stdout;
		expect(out).toMatch(/^DONE exit=0$/m);
		expect(
			out.match(
				/^bg-run: the monotonic clock would not read \(#2886\), so the suite ceiling's backstop skips each poll it fails on \(#3160\)$/gm,
			),
		).toHaveLength(1);
		const unread = readFileSync(join(root, "polls.log"), "utf8")
			.split("\n")
			.filter((l) => l === "mono-unread");
		expect(unread.length).toBeGreaterThanOrEqual(2);
		expect(existsSync(join(root, "kills.jsonl"))).toBe(false);
	});

	it("never kills a command that writes no deadline file", () => {
		const got = run(
			["run", "plain", "sh", "-c", `sleep ${THREE_BEATS_S}; echo finished`],
			{
				WFC_BG_CEILING_GRACE_S: "0",
			},
		);

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
