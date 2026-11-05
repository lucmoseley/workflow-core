// @vitest-environment node
/*
 * The SessionStart housekeeping launcher.
 *
 * Pins that it stays silent and exits 0, even where node is absent; that it
 * reaches the self-throttling sweep (mantahostels#1362); that it starts each
 * detached job it owns, in a session of its own; and that none of the
 * tracker-writing or file-deleting ones run under VITEST.
 *
 * Behavioural, not textual: a substring assertion on the hook's shell shape
 * passes vacuously, the `command -v node >/dev/null 2>&1` prefix satisfying a
 * check that the output is silenced (mantahostels#1251).
 *
 * It is a `SessionStart` hook in `self-plugin/hooks/hooks.json`: loosen a case
 * and a session start fails or prints into the transcript, a housekeeping job
 * stops running, or a test run deletes real scratch files or writes to the
 * real tracker.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// `vi` here is `vi.waitFor` only — a poll for a detached child to settle, not
// mocking (§X2).
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { shellQuote } from "./lib/sh-quote.js";

const SCRIPT = path.join(__dirname, "session-start-sweeps.sh");

/* A just-swept, empty cache for the self-throttling notice this launcher also
 * runs (mantahostels#1404): it then reports nothing and kicks no sweep of its own. An ABSENT file would not do — that is the one
 * state the notice answers by launching a 10-19s corpus walk. */
const quietThrottleState = () => {
	const file = path.join(os.tmpdir(), `throttle-quiet-${process.pid}.json`);
	fs.writeFileSync(
		file,
		JSON.stringify({ sweptAt: new Date().toISOString(), episodes: [] }),
	);
	return file;
};

/**
 * Every path the throttling half touches, pointed at the sandbox.
 *
 * WITHOUT THESE it reads the machine's own refresh stamp and APPENDS to the
 * machine's `~/.claude/self-throttling-history.jsonl` — a test writing real state, and
 * one whose extra filesystem work lands in the launcher's synchronous half.
 */
const throttleEnv = () => {
	const base = path.join(os.tmpdir(), `throttle-sandbox-${process.pid}`);
	fs.mkdirSync(base, { recursive: true });
	return {
		WFC_THROTTLE_STATE: quietThrottleState(),
		WFC_THROTTLE_REFRESH_STAMP: path.join(base, "refresh.stamp"),
		WFC_THROTTLE_HISTORY: path.join(base, "history.jsonl"),
		// "" neutralises an inherited leak (mantahostels#2120): noticeEnabled() only
		// recognises "1"/"0" and falls through to the built-in default for
		// anything else, unlike an unset var, which the leak is not.
		WFC_THROTTLE_NOTICE: "",
	};
};

/** Run the hook exactly as self-plugin/hooks/hooks.json does. */
const run = () =>
	spawnSync(SCRIPT, [], {
		encoding: "utf8",
		env: { ...process.env, ...throttleEnv() },
	});

describe("the SessionStart housekeeping launcher", () => {
	it("prints nothing into the transcript and exits green", () => {
		const r = run();
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		expect(r.stderr).toBe("");
	});

	it("is not itself fooled by an ambient WFC_THROTTLE_NOTICE (mantahostels#2120)", () => {
		// process.env, not throttleEnv()'s own pin: checks that the default
		// neutralises what a test never explicitly set, not only what it overrides.
		process.env.WFC_THROTTLE_NOTICE = "1";
		try {
			expect(run().stdout).toBe("");
		} finally {
			delete process.env.WFC_THROTTLE_NOTICE;
		}
	});

	it("also runs the self-throttling sweep, which is the piggyback mantahostels#1362 ruled", () => {
		const file = path.join(os.tmpdir(), `throttle-fired-${process.pid}.json`);
		/* Clock-relative, not a fixed ISO date (mantahostels#2184): the script's `--notify`
		 * drops any episode whose `end` is more than REPORT_WINDOW_DAYS behind the
		 * real Date.now(), and it has no WFC_NOW seam to pin that against.
		 * `29.8 * hourMs` must keep tracking the `hours` literal below. */
		const hourMs = 36e5;
		const end = Date.now() - hourMs;
		fs.writeFileSync(
			file,
			JSON.stringify({
				sweptAt: new Date().toISOString(),
				episodes: [
					{
						start: new Date(end - 29.8 * hourMs).toISOString(),
						end: new Date(end).toISOString(),
						hours: 29.8,
						beforeRatio: 0.82,
						afterRatio: 0.7,
						busyRate: 1755,
					},
				],
			}),
		);
		const r = spawnSync(SCRIPT, [], {
			encoding: "utf8",
			env: {
				...process.env,
				...throttleEnv(),
				WFC_THROTTLE_STATE: file,
				/* The notice ships OFF (mantahostels#1404), so the launcher is silent by
				 * default. Forced on here because what this test pins is the
				 * piggyback wiring — that the launcher reaches the detector at
				 * all — which a silence would assert nothing about. */
				WFC_THROTTLE_NOTICE: "1",
			},
		});
		// stdout, not stderr: a SessionStart hook injects only stdout.
		expect(r.stdout).toMatch(/SELF-THROTTLING SIGNAL \(1\)/);
		expect(r.status).toBe(0);
		fs.rmSync(file, { force: true });
	});

	/**
	 * Both limbs of the container sweep's `VITEST` guard (mantahostels#1632) are pinned here:
	 * a fake `node` on PATH logs every script the launcher reaches, and the
	 * session it runs in, so nothing real runs.
	 */
	const launcherReach = (env: Record<string, string | undefined>) => {
		const bin = fs.mkdtempSync(path.join(os.tmpdir(), "fake-node-"));
		/* The launcher's detached siblings keep appending to `reached.log` after
		 * a test has seen the one script it waits on, so a delete can meet a late
		 * write and throw ENOTEMPTY; the retry absorbs it (#683). At most three
		 * siblings can land late, against eleven tries over ~5.5 s — a margin
		 * sized by that count, not measured on CI. Residual: the siblings
		 * themselves outlive the test. */
		onTestFinished(() =>
			fs.rmSync(bin, {
				recursive: true,
				force: true,
				maxRetries: 10,
				retryDelay: 100,
			}),
		);
		const log = path.join(bin, "reached.log");
		fs.writeFileSync(
			path.join(bin, "node"),
			`#!/bin/sh\necho "$@" sid=$(ps -o sid= -p $$ | tr -d ' ') >> ${shellQuote(log)}\n`,
			{
				mode: 0o755,
			},
		);
		spawnSync(SCRIPT, [], {
			encoding: "utf8",
			env: {
				...process.env,
				...throttleEnv(),
				...env,
				PATH: `${bin}${path.delimiter}${process.env.PATH}`,
			},
		});
		return { log };
	};

	const reached = async (log: string, script: string) => {
		try {
			await vi.waitFor(
				() => expect(fs.readFileSync(log, "utf8")).toContain(script),
				{ timeout: 3000, interval: 50 },
			);
			return true;
		} catch {
			return false;
		}
	};

	it("launches the stale-container sweep, the piggyback mantahostels#1632 ruled", async () => {
		const { log } = launcherReach({ VITEST: undefined });
		expect(await reached(log, "retire-stale-containers.js")).toBe(true);
	});

	it("launches the scratch reaper, the piggyback mantahostels#2214 added", async () => {
		const { log } = launcherReach({ VITEST: undefined });
		expect(await reached(log, "scratch-sweep.js")).toBe(true);
	});

	it("never reaches the scratch reaper under VITEST, which deletes real files", async () => {
		const { log } = launcherReach({ VITEST: "1" });
		expect(await reached(log, "check-self-throttling.js")).toBe(true);
		expect(await reached(log, "scratch-sweep.js")).toBe(false);
	});

	it("never reaches the tracker-writing sweep under VITEST", async () => {
		const { log } = launcherReach({ VITEST: "1" });
		/* The throttling sweep proves the launcher ran at all — without it an
		 * absent log would pass this vacuously. */
		expect(await reached(log, "check-self-throttling.js")).toBe(true);
		expect(await reached(log, "retire-stale-containers.js")).toBe(false);
	});

	it("launches the queue-wait alarm, and never under VITEST (#1219)", async () => {
		const live = launcherReach({ VITEST: undefined });
		expect(await reached(live.log, "report-suite-queue-wait.js")).toBe(true);
		const test = launcherReach({ VITEST: "1" });
		expect(await reached(test.log, "check-self-throttling.js")).toBe(true);
		expect(await reached(test.log, "report-suite-queue-wait.js")).toBe(false);
	});

	it("launches the architecture-scan counter, and never under VITEST (#1378)", async () => {
		const live = launcherReach({ VITEST: undefined });
		expect(await reached(live.log, "report-arch-scan-due.js")).toBe(true);
		const test = launcherReach({ VITEST: "1" });
		expect(await reached(test.log, "check-self-throttling.js")).toBe(true);
		expect(await reached(test.log, "report-arch-scan-due.js")).toBe(false);
	});

	it("launches the heresy sweep filer, and never under VITEST (#3464)", async () => {
		const live = launcherReach({ VITEST: undefined });
		expect(await reached(live.log, "report-heresy-sweep-due.js")).toBe(true);
		const test = launcherReach({ VITEST: "1" });
		expect(await reached(test.log, "check-self-throttling.js")).toBe(true);
		expect(await reached(test.log, "report-heresy-sweep-due.js")).toBe(false);
	});

	it("launches the lander starter, and never under VITEST (#2405)", async () => {
		const live = launcherReach({ VITEST: undefined });
		expect(await reached(live.log, "start-lander.js")).toBe(true);
		const test = launcherReach({ VITEST: "1" });
		expect(await reached(test.log, "check-self-throttling.js")).toBe(true);
		expect(await reached(test.log, "start-lander.js")).toBe(false);
	});

	it("launches the landing stall check, and never under VITEST (#2406)", async () => {
		const live = launcherReach({ VITEST: undefined });
		expect(await reached(live.log, "check-landing-stall.js")).toBe(true);
		const test = launcherReach({ VITEST: "1" });
		expect(await reached(test.log, "check-self-throttling.js")).toBe(true);
		expect(await reached(test.log, "check-landing-stall.js")).toBe(false);
	});

	it("launches the daily repo checks in a session of its own, and never under VITEST (#1555)", async () => {
		const live = launcherReach({ VITEST: undefined });
		expect(await reached(live.log, "repo-checks.js")).toBe(true);
		/* setsid's session, out of reach of the group kill a hook timeout
		 * sends, where a plain `&` would share this test's. */
		const ours = execFileSync("ps", ["-o", "sid=", "-p", String(process.pid)], {
			encoding: "utf8",
		}).trim();
		const line = fs
			.readFileSync(live.log, "utf8")
			.split("\n")
			.find((l) => l.includes("repo-checks.js"));
		expect(line).toMatch(/ sid=\d+$/);
		expect(line?.endsWith(` sid=${ours}`)).toBe(false);
		const test = launcherReach({ VITEST: "1" });
		expect(await reached(test.log, "check-self-throttling.js")).toBe(true);
		expect(await reached(test.log, "repo-checks.js")).toBe(false);
	});

	it("exits green where node is absent, rather than failing a session start", () => {
		// bash by absolute path: with PATH emptied the spawn itself would fail to
		// resolve it, and a spawn error reads as a null status, not a green one.
		const r = spawnSync("/bin/bash", [SCRIPT], {
			encoding: "utf8",
			env: { ...process.env, PATH: "" },
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
	});
});
