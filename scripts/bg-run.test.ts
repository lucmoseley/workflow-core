// @vitest-environment node

import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	BOUNDED,
	bgRunRoot,
	CEILING_MS,
	check,
	createDirLate,
	env,
	expectMidCommand,
	FAST,
	KILLED_LIFETIME_S,
	parseFirstLine,
	pastStale,
	poll,
	QUICK_BEAT,
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
	spawnDetached,
	TIGHT_MISSING,
	untilPublished,
	untilVerdict,
	WIDE_MISSING,
	waitFor,
} from "./lib/bg-run-testkit";
import { ignoreFailure } from "./lib/caught.js";
import { commandPath } from "./lib/command-path-testkit";
import { shellQuote } from "./lib/sh-quote.js";

const { waitForGate } = require("./lib/suite-queue.js");

bgRunRoot();

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
			["run", "instant", "sh", "-c", shWaitFor(`[ -e ${shellQuote(armed)} ]`)],
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
			env: env(QUICK_BEAT),
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
				env: env(QUICK_BEAT),
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

describe("wait", () => {
	// guess, #5143
	const quickPoll = { WFC_BG_WAIT_POLL_S: "0.2" };

	function wait(
		name: string,
		ceiling: string,
		extra: Record<string, string> = {},
	) {
		return run(["wait", name, ceiling], extra);
	}

	function spawnWait(name: string, ceiling: string) {
		const child = spawn(SCRIPT, ["wait", name, ceiling], {
			env: env(quickPoll),
		});
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
		expectPolledUntil("0");
	});

	it("reports RUNNING once the ceiling expires on a still-live job", async () => {
		const child = spawn(SCRIPT, ["run", "slow", "sleep", KILLED_LIFETIME_S], {
			env: env(),
		});
		await untilPublished("slow");
		const got = wait("slow", "1", quickPoll);
		expect(got.status).toBe(2);
		expect(parseFirstLine(got.stdout)).toContain("RUNNING");
		child.kill("SIGKILL");
	});

	it("detects a wrapper killed while wait is already blocking on it", async () => {
		const runChild = spawn(
			SCRIPT,
			["run", "midkill", "sleep", KILLED_LIFETIME_S],
			{
				env: env(QUICK_BEAT),
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
		expectPolledUntil("1");
	});

	it("refuses a name it has never run, same as check", () => {
		const got = wait("never-waited", "1", TIGHT_MISSING);
		expect(got.status).toBe(3);
		expect(got.stderr).toContain("no run named");
	});
});

const DEFAULT_MISSING_POLLS = Math.round(2 / 0.1);

describe("the run-directory creation race", () => {
	it("does not report 'no run named' when the directory lands inside the window", () => {
		createDirLate(join(root, "racy"), false);
		const got = check("racy", WIDE_MISSING);
		expect(got.stderr).not.toContain("no run named");
		expect(got.status).not.toBe(3);
		expect(got.stdout).toContain("RUNNING");
		expect(readPolls().missing).toBeGreaterThan(0);
	});

	it("gives an actual 'run' the same grace, not just a fabricated directory", () => {
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
			expect(got.status).toBe(2);
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
			expect(got.status).toBe(2);
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
		expect(run(["run", "relaunched", "true"]).status).toBe(0);
		const bin = join(root, "bin");
		mkdirSync(bin);
		const realRm = commandPath("rm");
		writeFileSync(
			join(bin, "rm"),
			`#!/usr/bin/env bash
marked=()
for a in "$@"; do [ -f "$a/token" ] && marked+=("$a"); done
${shellQuote(realRm)} "$@"
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
	const gate = () => join(root, "gate");
	const openGate = (point: string) => writeFileSync(`${gate()}.${point}`, "");
	const atGate = (point: string) =>
		waitFor(`the check to hold at ${point}`, () =>
			existsSync(`${gate()}.${point}.waiting`),
		);

	function gatedCheck(name: string, extra: Record<string, string> = {}) {
		const child = spawn(SCRIPT, ["check", name], {
			env: env({ WFC_BG_CHECK_GATE: gate(), ...WIDE_MISSING, ...extra }),
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

	const toGrave = (name: string, n: number) =>
		renameSync(join(root, name), join(root, `.grave-${name}-${n}`));

	it("answers for the re-run, recording no kill, when the old directory goes to its grave mid-read", async () => {
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
			const gated = gatedCheck("rerecorded", pastStale());
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
			for (const pid of [firstPid, secondPid])
				if (pid !== undefined)
					ignoreFailure(() => process.kill(-pid, "SIGKILL"));
		}
	});
});

describe("the beat-write race (mantahostels#2666)", () => {
	it("still reports 'KILLED before the first beat' when beat is genuinely absent", () => {
		const dir = join(root, "no-beat-yet");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "out"), "");
		const got = check("no-beat-yet");
		expect(got.stdout).toContain("KILLED before the first beat");
		expect(got.status).toBe(1);
	});

	it("never reports 'KILLED before the first beat' for a run barely started", async () => {
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

	it("releases the caller's output pipe when the command returns, not a heartbeat later (#4303)", () => {
		const got = spawnSync(SCRIPT, ["run", "piped", "true"], {
			env: env({ WFC_BG_HEARTBEAT_S: "600" }),
			encoding: "utf8",
			timeout: CEILING_MS,
			killSignal: "SIGKILL",
		});
		expect(got.error).toBeUndefined();
		expect(got.status).toBe(0);
	});
});

describe("the memory sample's descendant walk (mantahostels#2683)", () => {
	it("counts a grandchild the wrapped command forks, not just its own launcher", async () => {
		const name = "forked-worker";
		const workerPath = join(root, "worker.sh");
		writeFileSync(
			workerPath,
			`#!/bin/sh\nx=$(head -c 20000000 /dev/zero | tr '\\0' 'a')\nsleep ${KILLED_LIFETIME_S}\n`,
			{ mode: 0o755 },
		);
		const proc = spawn(
			SCRIPT,
			["run", name, "sh", "-c", `${shellQuote(workerPath)} & wait`],
			{
				env: env(QUICK_BEAT),
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

		expect(rssKb).toBeGreaterThan(15_000);
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
			["run", name, "sh", "-c", `${shellQuote(workerPath)} & wait`],
			{
				env: env({ ...QUICK_BEAT, WFC_BG_MAX_DESCENDANTS: "1" }),
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
				env: env(QUICK_BEAT),
			},
		);
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

	it("records elapsed_s against the beat's death time, not against whenever check happens to run", async () => {
		const dir = join(root, "late-checked");
		mkdirSync(dir, { recursive: true });
		const launched = Math.floor(Date.now() / 1000) - 600;
		const died = launched + 3;
		writeFileSync(join(dir, "started"), `${launched}\n`);
		writeFileSync(join(dir, "out"), "");
		writeFileSync(join(dir, "beat"), "");
		utimesSync(join(dir, "beat"), died, died);

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
		expect(Number(rec.death_epoch)).toBeLessThanOrEqual(
			Math.floor(Date.now() / 1000),
		);
		expect(Number(rec.death_epoch) - Number(rec.started_epoch)).toBe(
			Number(rec.elapsed_s),
		);
		expect(rec.heartbeat_s).toBe(Number(FAST.WFC_BG_HEARTBEAT_S));
	});

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
				env: env(QUICK_BEAT),
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
