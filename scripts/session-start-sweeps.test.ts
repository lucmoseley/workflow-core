// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { shellQuote } from "./lib/sh-quote.js";
import { writeSystemdRun } from "./lib/systemd-run-fake";

const SCRIPT = path.join(__dirname, "session-start-sweeps.sh");

const quietThrottleState = () => {
	const file = path.join(os.tmpdir(), `throttle-quiet-${process.pid}.json`);
	fs.writeFileSync(
		file,
		JSON.stringify({ sweptAt: new Date().toISOString(), episodes: [] }),
	);
	return file;
};

const throttleEnv = () => {
	const base = path.join(os.tmpdir(), `throttle-sandbox-${process.pid}`);
	fs.mkdirSync(base, { recursive: true });
	return {
		WFC_THROTTLE_STATE: quietThrottleState(),
		WFC_THROTTLE_REFRESH_STAMP: path.join(base, "refresh.stamp"),
		WFC_THROTTLE_HISTORY: path.join(base, "history.jsonl"),
		WFC_THROTTLE_NOTICE: "",
	};
};

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
		vi.stubEnv("WFC_THROTTLE_NOTICE", "1");
		expect(run().stdout).toBe("");
	});

	it("also runs the self-throttling sweep, which is the piggyback mantahostels#1362 ruled", () => {
		const file = path.join(os.tmpdir(), `throttle-fired-${process.pid}.json`);
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
				WFC_THROTTLE_NOTICE: "1",
			},
		});
		expect(r.stdout).toMatch(/SELF-THROTTLING SIGNAL \(1\)/);
		expect(r.status).toBe(0);
		fs.rmSync(file, { force: true });
	});

	const launcherReach = (env: Record<string, string | undefined>) => {
		const bin = fs.mkdtempSync(path.join(os.tmpdir(), "fake-node-"));
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
				WFC_SYSTEMD_RUN: writeSystemdRun(bin, { answers: false }).bin,
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
		expect(await reached(log, "sweep-scratch.js")).toBe(true);
	});

	it("never reaches the scratch reaper under VITEST, which deletes real files", async () => {
		const { log } = launcherReach({ VITEST: "1" });
		expect(await reached(log, "check-self-throttling.js")).toBe(true);
		expect(await reached(log, "sweep-scratch.js")).toBe(false);
	});

	it("never reaches the tracker-writing sweep under VITEST", async () => {
		const { log } = launcherReach({ VITEST: "1" });
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

	const Outliving = [
		"retire-stale-containers.js",
		"sweep-scratch.js",
		"report-close-check-reading.js",
		"report-suite-queue-wait.js",
		"report-arch-scan-due.js",
		"repo-checks.js",
		"report-round-check-reading.js",
		"start-lander.js",
		"check-landing-stall.js",
		"report-flip-line-reading.js",
		"report-heresy-sweep-due.js",
		"start-orphan-sweep-timer.js",
		"claude-child.js chrome-close --sweep",
		" gc --auto",
	];

	async function launchOutliving(answers: boolean) {
		const bin = fs.mkdtempSync(path.join(os.tmpdir(), "outlive-launch-"));
		onTestFinished(() =>
			fs.rmSync(bin, {
				recursive: true,
				force: true,
				maxRetries: 10,
				retryDelay: 100,
			}),
		);
		const log = path.join(bin, "reached.log");
		for (const name of ["node", "git"])
			fs.writeFileSync(
				path.join(bin, name),
				`#!/bin/sh\necho "${name} $* sid=\${CLAUDE_CODE_SESSION_ID-} job=\${CLAUDE_JOB_DIR-} owner=\${WFC_REPORT_OWNER-} manager=\${WFC_USER_MANAGER-}" >> ${shellQuote(log)}\necho "stdout of ${name} $*"\n`,
				{ mode: 0o755 },
			);
		const fake = writeSystemdRun(bin, { answers });
		const project = path.join(bin, "project");
		fs.mkdirSync(project);
		spawnSync(SCRIPT, [], {
			encoding: "utf8",
			env: {
				...process.env,
				...throttleEnv(),
				VITEST: undefined,
				WFC_SYSTEMD_RUN: fake.bin,
				CLAUDE_PROJECT_DIR: project,
				CLAUDE_CODE_SESSION_ID: "starter",
				CLAUDE_JOB_DIR: "/the/job",
				WFC_REPORT_OWNER: "stale",
				CLAUDE_PID: "4242",
				PATH: `${bin}${path.delimiter}${process.env.PATH}`,
			},
		});
		const reachedLines = () => fs.readFileSync(log, "utf8").trim().split("\n");
		await vi.waitFor(
			() =>
				expect(
					Outliving.every((job) => reachedLines().some((l) => l.includes(job))),
				).toBe(true),
			{ timeout: 5000, interval: 50 },
		);
		return { lines: reachedLines(), fake, project };
	}

	it("appends the lander start's output to the lander's log (#4706)", async () => {
		const { project } = await launchOutliving(true);
		const logs = (fs.readdirSync(project, { recursive: true }) as string[])
			.filter((f) => path.basename(f) === ".lander.log")
			.map((f) => fs.readFileSync(path.join(project, f), "utf8"));
		expect(logs).toEqual([
			expect.stringMatching(/^stdout of node \S*start-lander\.js/m),
		]);
	});

	it("launches every job but the session's scope as no session, owned by the starter, capped at 45 minutes, marked as outliving its session (#4706, #4749)", async () => {
		const { lines, fake } = await launchOutliving(true);
		expect(fake.probes()).toBe(1);
		expect(lines.find((l) => l.includes("check-self-throttling.js"))).toMatch(
			/ manager=yes$/,
		);
		const calls = fake.calls();
		for (const job of Outliving)
			expect(calls.find((c) => c.command.includes(job))).toMatchObject({
				words: "--user --scope --quiet -p RuntimeMaxSec=2700 --",
				sid: "",
				job: "",
				owner: "starter",
				outlives: "4242:2700",
			});
		expect(calls.some((c) => c.command.includes("session-scope.js"))).toBe(
			false,
		);
		expect(lines.find((l) => l.includes("session-scope.js"))).toMatch(
			/ sid=starter job=\/the\/job owner=stale manager=$/,
		);
	});

	it("starts each job unscoped, still stripped and owner-tagged, where no manager answers (#4706)", async () => {
		const { lines, fake } = await launchOutliving(false);
		expect(fake.probes()).toBe(1);
		expect(lines.find((l) => l.includes("check-self-throttling.js"))).toMatch(
			/ manager=no$/,
		);
		expect(fake.calls()).toEqual([]);
		for (const job of Outliving)
			expect(lines.find((l) => l.includes(job))).toMatch(
				/ sid= job= owner=starter manager=$/,
			);
	});

	it("exits green where node is absent, rather than failing a session start", () => {
		const r = spawnSync("/bin/bash", [SCRIPT], {
			encoding: "utf8",
			env: { ...process.env, PATH: "" },
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
	});
});
