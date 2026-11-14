// @vitest-environment node
/*
 * throughput-readout.test.ts — the throughput readout's command line
 * (#5196, #5205). Break it and a source that would not read passes as a quiet
 * window, or a bad argument prints a reading over nothing. The bands
 * themselves are pinned in lib/throughput-readout.test.ts, which hands the
 * core plain records; the reads of each source are reached only from here.
 *
 * Each case runs the command in-process against a throwaway directory, its
 * `gh` stubbed at WFC_GH, its python at WFC_PYTHON where a case feeds
 * dense_minute.py's output, and every seat, record and log pointed into that
 * directory, so nothing reaches the network or this machine's records.
 *
 * Its wall time tracks the machine's load, each case but one running
 * dense_minute.py for real: 3.7 s at load 7.5, 11.0 s at load 18 (#5196).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeJobRecord } from "./lib/background-start-testkit";
import { appendTick } from "./lib/concurrency.js";
import { record } from "./lib/dispatch-ledger.js";
import { printed, refused, stubGhRoutes } from "./lib/gh-stub";
import { defineTemplate, initGitRepo } from "./lib/git-fixture";
import { jobDirPath } from "./lib/job-paths.js";
import { markersDir } from "./lib/marker-root.js";
import { queueExitLogger } from "./lib/queue-exit-log.js";
import { runInProcess } from "./lib/run-in-process";
import { appendLedgerLine } from "./lib/run-ledger.js";

const SCRIPT = path.join(__dirname, "throughput-readout.js");
const SINCE = "2026-11-10T00:00:00Z";
const UNTIL = "2026-11-12T00:00:00Z";
const T0 = Date.parse(SINCE);
const MIN = 60_000;
const HOUR = 60 * MIN;
const REPO = "owner/tracker";
/* The minute log's span and the session count on each of its lines. */
const WINDOW_HOURS = 48;
const SESSIONS = 3;

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "throughput-cli-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const at = (t: number) => new Date(t).toISOString();
const seatDir = () => path.join(dir, "seat");
const refillDir = () => path.join(dir, "refill");

function writeMinuteLog(from = T0) {
	const lines = Array.from({ length: WINDOW_HOURS * 60 }, (_, i) =>
		JSON.stringify({ ts: at(from + i * MIN), load1: 1, sessions: SESSIONS }),
	);
	fs.writeFileSync(path.join(dir, "minute.jsonl"), `${lines.join("\n")}\n`);
}

const day = (closes: { number: number; closedAt: string }[]) =>
	printed(
		JSON.stringify(
			closes.map((c) => ({
				...c,
				repository: { name: "tracker", nameWithOwner: REPO },
			})),
		),
	);

function run(
	args: string[],
	routes: Parameters<typeof stubGhRoutes>[1] = {
		"search issues*--closed 2026-11-10 *": day([
			{ number: 1, closedAt: "2026-11-10T01:00:00Z" },
		]),
		"search issues*--closed 2026-11-11 *": day([]),
	},
) {
	const seat = seatDir();
	fs.mkdirSync(path.join(seat, "jobs"), { recursive: true });
	fs.mkdirSync(refillDir(), { recursive: true });
	const stub = stubGhRoutes(dir, routes);
	return runInProcess(
		SCRIPT,
		[
			"--owner",
			"owner",
			"--markers",
			markersDir(dir),
			"--config-dir",
			seat,
			"--checkout",
			`${REPO}=${path.join(dir, "code")}`,
			...args,
		],
		{
			cwd: dir,
			env: {
				...process.env,
				...stub.env,
				CLAUDE_PROJECT_DIR: dir,
				CLAUDE_CONFIG_DIR: seat,
				WFC_CLAUDE_CONFIG_A: seat,
				WFC_CLAUDE_CONFIG_B: seat,
				WFC_CLAUDE_CONFIG_C: seat,
				MEMWATCH_MINUTE_LOG: path.join(dir, "minute.jsonl"),
				WFC_REFILL_DIR: refillDir(),
			},
		},
	);
}

/* A checkout whose one close is built then reverted, the revert naming its
 * target by its body line or by its subject alone. */
function buildRevertedCheckout(bodyLine: boolean) {
	return (code: string) => {
		initGitRepo(code, "/dev/null");
		const git = (...a: string[]) =>
			spawnSync("git", ["-C", code, ...a], {
				encoding: "utf8",
				env: {
					...process.env,
					GIT_COMMITTER_DATE: "2026-11-10T00:30:00Z",
				},
			});
		fs.writeFileSync(path.join(code, "a"), "a");
		git("add", "a");
		git("commit", "-q", "--no-verify", "-m", "Build it (#1)");
		git("revert", "--no-edit", "HEAD");
		if (!bodyLine)
			git(
				"commit",
				"-q",
				"--amend",
				"--no-verify",
				"-m",
				'Revert "Build it (#1)"',
			);
	};
}

const checkouts = defineTemplate({
	bodyLine: buildRevertedCheckout(true),
	subject: buildRevertedCheckout(false),
});

it.each([
	["its body line", "bodyLine"],
	["its subject alone", "subject"],
])(
	"prints the bands as JSON, a close reverted by %s subtracted through the checkout's log",
	(_, variant) => {
		writeMinuteLog();
		checkouts.instantiate(path.join(dir, "code"), variant);
		const r = run(["--since", SINCE, "--until", UNTIL, "--json"]);
		expect(r.status).toBe(0);
		const out = JSON.parse(r.stdout);
		expect(out.sessions).toHaveLength(1);
		expect(out.sessions[0]).toMatchObject({
			band: "3",
			hours: 48,
			closes: 1,
			reverted: 1,
			counted: 0,
			thin: false,
		});
		/* The load edges scale per core, 2 a core the lowest; load 1 is under
		 * it on any host. */
		expect(out.load[0].band).toBe(`<${2 * os.cpus().length}`);
	},
);

it("reads the limb, queue share and session split off a tick, a queue exit, a dispatch row and two job records", () => {
	/* The writers stamp the wall clock, and the tick and run writers prune
	 * lines a month old, so the window sits about now (#5205). */
	const now = Date.now();
	const h = now - (now % HOUR);
	const since = h - 24 * HOUR;
	writeMinuteLog(since);
	const markers = markersDir(dir);
	fs.mkdirSync(refillDir(), { recursive: true });
	vi.stubEnv("WFC_REFILL_DIR", refillDir());
	/* The loop's live count overrides the minute line's while the tick is
	 * fresh, its first 16 minutes of the hour: a mean of ~3.5 there, band 4. */
	appendTick({
		at: at(h - 2 * HOUR),
		live: SESSIONS + 2,
		ceiling: 12,
		working: SESSIONS + 2,
		binding: { limit: "CPU", why: "load1 30.0 is over the ceiling of 24" },
		also: [],
		memory: null,
	});
	queueExitLogger({
		file: path.join(markers, ".suite-queue-exits.jsonl"),
		kind: "touched",
		slotFree: true,
		session: "s1",
		label: "test",
		err: process.stderr,
	})("opened", 10 * MIN);
	appendLedgerLine(
		dir,
		{
			sha: "a".repeat(40),
			at: at(now + MIN),
			startedAt: at(now),
			durationMs: MIN,
			suite: "vitest",
			sessionId: "s1",
			scope: {
				resolvedFiles: 1,
				wholeSlot: false,
				modulesRun: 1,
				modulesTotal: 1,
				tests: 1,
				skipped: 0,
			},
		},
		true,
	);
	record({
		root: dir,
		issues: [1],
		model: "opus",
		prompt: "/implement 1",
		jobId: "sent",
		launchedAt: h - 10 * HOUR,
	});
	const seat = seatDir();
	/* A finished job's record keeps updating: its life ends at its first
	 * terminal state, 2 h after it started, not at its last update. */
	writeJobRecord(jobDirPath(seat, "sent"), "implement", {
		createdAt: at(h - 10 * HOUR),
		firstTerminalAt: at(h - 8 * HOUR),
		updatedAt: at(h - HOUR),
	});
	writeJobRecord(jobDirPath(seat, "mine"), "claude", {
		createdAt: at(h - 6 * HOUR),
		updatedAt: at(h - 5 * HOUR),
	});
	const r = run(
		[
			"--since",
			at(since),
			"--until",
			at(since + WINDOW_HOURS * HOUR),
			"--json",
		],
		{ "search issues*": day([]) },
	);
	expect(r.status).toBe(0);
	const bands = JSON.parse(r.stdout).sessions;
	const looped = bands.find((b: { band: string }) => b.band === "4");
	const band = bands.find((b: { band: string }) => b.band === String(SESSIONS));
	expect(looped).toMatchObject({ hours: 1 });
	expect(looped.limbShare).toEqual({
		load: 1,
		sessions: 0,
		memory: 0,
		"Windows memory": 0,
		none: 0,
	});
	expect(band.hours).toBe(WINDOW_HOURS - 1);
	/* toBeCloseTo's default 2 digits would pass 0, a queue reader that read
	 * nothing, against this ~0.0012. */
	expect(band.queueShare).toBeCloseTo(
		(10 * 60) / (SESSIONS * (WINDOW_HOURS - 1) * 3600),
		8,
	);
	expect(band.dispatchedHours).toBeCloseTo(2);
	expect(band.handOpenedHours).toBeCloseTo(1);
});

it("reads each minute's Bash round-trips and hook-timeout refusals off dense_minute.py's output", () => {
	writeMinuteLog();
	const python = path.join(dir, "python3");
	const minute = (t: number, bash: number[], hto: number) =>
		JSON.stringify({ minute: at(t), bash_s: bash, hto });
	fs.writeFileSync(
		python,
		`#!/bin/sh\ncat <<'EOF'\n${minute(T0, [1, 3], 0)}\n${minute(T0 + MIN, [5], 2)}\nEOF\n`,
		{ mode: 0o755 },
	);
	vi.stubEnv("WFC_PYTHON", python);
	const r = run(["--since", SINCE, "--until", UNTIL, "--json"]);
	expect(r.status).toBe(0);
	const b = JSON.parse(r.stdout).sessions[0];
	expect(b.bashMedianS).toBe(3);
	expect(b.refusalsPerHour).toBeCloseTo(2 / WINDOW_HOURS);
});

/* #5196: an unreadable log crashed the readout; the missing-log case below is
 * its positive pair. */
it("names a minute log that will not read with the hours it lacks and still exits 0 (#5196)", () => {
	fs.mkdirSync(path.join(dir, "minute.jsonl"));
	const r = run(["--since", SINCE, "--until", UNTIL]);
	expect(r.status).toBe(0);
	expect(r.stdout).toContain("Lacking — minute log: 48.0 h");
	expect(r.stdout).toContain("the minute log would not read");
	expect(r.stdout).not.toContain("Lacking — queue logs");
});

it.each([
	[
		"the queue-exit log",
		path.join("markers", ".suite-queue-exits.jsonl"),
		"queue logs",
		"a log the queue replay reads would not read (EISDIR)",
	],
	[
		"pick-next's dispatch log",
		path.join("markers", ".pick-next", "dispatched.jsonl"),
		"dispatch log",
		"pick-next's dispatch log would not read",
	],
	[
		"the refill tick record",
		path.join("refill", "concurrency.jsonl"),
		"binding limb",
		"the refill tick record would not read",
	],
])(
	"names %s that will not read with the hours it lacks and still exits 0 (#5196)",
	(_, file, source, why) => {
		writeMinuteLog();
		const [root, ...rest] = file.split(path.sep);
		fs.mkdirSync(
			path.join(root === "markers" ? markersDir(dir) : refillDir(), ...rest),
			{ recursive: true },
		);
		const r = run(["--since", SINCE, "--until", UNTIL, "--json"]);
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout).lacking).toContainEqual({
			source,
			hours: WINDOW_HOURS,
			why,
		});
	},
);

it("names a missing minute log with the hours it lacks and still exits 0", () => {
	const r = run(["--since", SINCE, "--until", UNTIL]);
	expect(r.status).toBe(0);
	expect(r.stdout).toContain("Lacking — minute log: 48.0 h");
	expect(r.stdout).toContain("the minute log would not read");
});

it("names a day gh failed on, counts none of its closes and still exits 0", () => {
	writeMinuteLog();
	const r = run(["--since", SINCE, "--until", UNTIL, "--json"], {
		"search issues*--closed 2026-11-10 *": refused("HTTP 502: Bad Gateway"),
		"search issues*--closed 2026-11-11 *": day([
			{ number: 2, closedAt: "2026-11-11T01:00:00Z" },
		]),
	});
	expect(r.status).toBe(0);
	const out = JSON.parse(r.stdout);
	expect(out.failedDays).toEqual([
		{ date: "2026-11-10", why: expect.stringContaining("502") },
	]);
	expect(out.lacking).toContainEqual(
		expect.objectContaining({ source: "closes", hours: 24 }),
	);
	expect(out.sessions[0].closesPerHour).toBeCloseTo(1 / 24);
});

it("reports a day at the search cap as truncated", () => {
	writeMinuteLog();
	const full = Array.from({ length: 1000 }, (_, i) => ({
		number: i,
		closedAt: "2026-11-10T01:00:00Z",
	}));
	const r = run(["--since", SINCE, "--until", UNTIL], {
		"search issues*--closed 2026-11-10 *": day(full),
		"search issues*--closed 2026-11-11 *": day([]),
	});
	expect(r.status).toBe(0);
	expect(r.stdout).toContain(
		"Truncated — 2026-11-10 hit the 1000-result search cap",
	);
});

it.each([
	[["--since", "yesterday", "--until", UNTIL], "--since first"],
	[["--since", UNTIL, "--until", SINCE], "--since first"],
	[["--since", SINCE, "--until", UNTIL, "--era", "after"], "after is not"],
	[["--since", SINCE, "--until", UNTIL, "--checkout", "nodir"], "nodir is not"],
])("exits 2 on a bad argument: %j", (args, names) => {
	const r = run(args);
	expect(r.status).toBe(2);
	expect(r.stderr).toContain(names);
	expect(r.stderr).toContain("usage:");
});
