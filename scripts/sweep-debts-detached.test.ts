// @vitest-environment node
/*
 * The SessionStart drain (mantahostels#1251).
 *
 * The register's ONLY drain since a claim stopped retiring anything.
 *
 * Behavioural, not textual: a substring assertion on the hook's shell shape
 * passes vacuously, the `command -v node >/dev/null 2>&1` prefix satisfying a
 * check that the output is silenced (mantahostels#1251).
 *
 * It also pins what the launcher starts detached beside the drain, and that
 * none of the tracker-writing or file-deleting ones run under VITEST. It is a
 * `SessionStart` hook in `.claude/settings.json`: loosen a case and debts
 * accrete undrained, a session start fails or prints into the transcript, or
 * a test run deletes real scratch files or writes to the real tracker.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// `vi` here is `vi.waitFor` only — a poll for a detached child to settle, not
// mocking (§X2).
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
	fakeGh,
	freshSandbox,
	ghClosedList,
	store,
} from "./lib/arbiter-testkit";

const SCRIPT = path.join(__dirname, "sweep-debts-detached.sh");
const REL = "docs/doc-map.md";

/** Run the hook exactly as .claude/settings.json does. */
/* A just-swept, empty cache for the self-throttling notice this launcher also
 * runs (mantahostels#1404): it then reports nothing and kicks no sweep of its own, leaving
 * the debt half alone under test. An ABSENT file would not do — that is the one
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
 * one whose extra filesystem work lands in the launcher's synchronous half,
 * where the assertion below is timing the detached debt child against it.
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

const run = () =>
	spawnSync(SCRIPT, [], {
		encoding: "utf8",
		env: { ...process.env, ...throttleEnv() },
	});

describe("the SessionStart debt drain", () => {
	const sb = freshSandbox(() => {
		// A repo the arbiter will accept a path inside, since `debt own` refuses
		// anything outside one.
		execFileSync("git", ["init", "-q"], { cwd: sb.repo });
		fs.mkdirSync(path.join(sb.repo, "docs"), { recursive: true });
		fs.writeFileSync(path.join(sb.repo, REL), "body\n");
	});

	it("retires a closed issue's entry after its own exit, so the next session start is clean", async () => {
		/* A gh that sleeps before answering, so the detached child is provably
		 * still running when the launcher returns. `ghClosedList` answers
		 * instantly, which leaves the assertion below racing it. */
		fakeGh(sb, `sleep 1; echo '[{"number":73}]'`);
		store.ownDebt(REL, 73, "an edit owed on a ticket that has since closed");

		const r = run();

		// Returns to the session start immediately: the whole `gh issue list` is
		// still ahead of the child at this point (mantahostels#1111).
		expect(r.status).toBe(0);
		/* Still there, so the launcher did not wait on the child, because the stub gh above sleeps a second and the child is
		 * blocked on it. That sleep is what makes this assertion mean something:
		 * against an instant gh the child can finish inside the parent's own
		 * runtime, and "not yet" then fails on a fast machine or a loaded one
		 * without anything being wrong (observed at mantahostels#1404). */
		expect(store.readDebts(REL)).toHaveLength(1);

		await vi.waitFor(() => expect(store.readDebts(REL)).toHaveLength(0), {
			timeout: 15_000,
			interval: 100,
		});
	}, 20_000);

	it("says nothing about the register, which never reaches the transcript", () => {
		ghClosedList(sb, []);
		store.ownDebt(REL, 73, "still owed");
		const r = run();
		expect(r.stdout).toBe("");
		expect(r.stderr).toBe("");
	});

	it("is not itself fooled by an ambient WFC_THROTTLE_NOTICE (mantahostels#2120)", () => {
		// process.env, not throttleEnv()'s own pin: checks that the default
		// neutralises what a test never explicitly set, not only what it overrides.
		process.env.WFC_THROTTLE_NOTICE = "1";
		try {
			ghClosedList(sb, []);
			store.ownDebt(REL, 73, "still owed");
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
			`#!/bin/sh\necho "$@" sid=$(ps -o sid= -p $$ | tr -d ' ') >> ${log}\n`,
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
		expect(await reached(log, "session-arbiter.js")).toBe(true);
		expect(await reached(log, "scratch-sweep.js")).toBe(false);
	});

	it("never reaches the tracker-writing sweep under VITEST", async () => {
		const { log } = launcherReach({ VITEST: "1" });
		/* The debt sweep proves the launcher ran at all — without it an absent
		 * log would pass this vacuously. */
		expect(await reached(log, "session-arbiter.js")).toBe(true);
		expect(await reached(log, "retire-stale-containers.js")).toBe(false);
	});

	it("launches the queue-wait alarm, and never under VITEST (#1219)", async () => {
		const live = launcherReach({ VITEST: undefined });
		expect(await reached(live.log, "report-suite-queue-wait.js")).toBe(true);
		const test = launcherReach({ VITEST: "1" });
		expect(await reached(test.log, "session-arbiter.js")).toBe(true);
		expect(await reached(test.log, "report-suite-queue-wait.js")).toBe(false);
	});

	it("launches the architecture-scan counter, and never under VITEST (#1378)", async () => {
		const live = launcherReach({ VITEST: undefined });
		expect(await reached(live.log, "report-arch-scan-due.js")).toBe(true);
		const test = launcherReach({ VITEST: "1" });
		expect(await reached(test.log, "session-arbiter.js")).toBe(true);
		expect(await reached(test.log, "report-arch-scan-due.js")).toBe(false);
	});

	it("launches the heresy sweep filer, and never under VITEST (#3464)", async () => {
		const live = launcherReach({ VITEST: undefined });
		expect(await reached(live.log, "report-heresy-sweep-due.js")).toBe(true);
		const test = launcherReach({ VITEST: "1" });
		expect(await reached(test.log, "session-arbiter.js")).toBe(true);
		expect(await reached(test.log, "report-heresy-sweep-due.js")).toBe(false);
	});

	it("launches the lander starter, and never under VITEST (#2405)", async () => {
		const live = launcherReach({ VITEST: undefined });
		expect(await reached(live.log, "start-lander.js")).toBe(true);
		const test = launcherReach({ VITEST: "1" });
		expect(await reached(test.log, "session-arbiter.js")).toBe(true);
		expect(await reached(test.log, "start-lander.js")).toBe(false);
	});

	it("launches the landing stall check, and never under VITEST (#2406)", async () => {
		const live = launcherReach({ VITEST: undefined });
		expect(await reached(live.log, "check-landing-stall.js")).toBe(true);
		const test = launcherReach({ VITEST: "1" });
		expect(await reached(test.log, "session-arbiter.js")).toBe(true);
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
		expect(await reached(test.log, "session-arbiter.js")).toBe(true);
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

	it("leaves every entry standing when gh cannot answer", async () => {
		ghClosedList(sb, [73]);
		process.env.WFC_GH = path.join(sb.dir, "no-such-gh");
		store.ownDebt(REL, 73, "an edit owed on a ticket that has since closed");
		expect(run().status).toBe(0);

		// WAIT FOR THE CHILD TO HAVE FAILED, then assert. Asserting straight after
		// `run()` cannot fail: the sweep is detached, so the register is trivially
		// intact whatever the sweep would have done to it.
		await vi.waitFor(
			() => expect(fs.readFileSync(sb.errorLog(), "utf8")).toContain("sweep"),
			{ timeout: 15_000, interval: 100 },
		);
		expect(store.readDebts(REL)).toHaveLength(1);
	}, 20_000);
});
