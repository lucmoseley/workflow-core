// @vitest-environment node
/*
 * throughput-readout.test.ts — the throughput readout's command line
 * (#5196). Break it and a source that would not read passes as a quiet
 * window, or a bad argument prints a reading over nothing. The bands
 * themselves are pinned in lib/throughput-readout.test.ts, which hands the
 * core plain records; the reads of each source are reached only from here.
 *
 * Each case runs the command in-process against a throwaway directory, its
 * `gh` stubbed at WFC_GH and every seat, record and log pointed into that
 * directory, so nothing reaches the network or this machine's records.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { printed, refused, stubGhRoutes } from "./lib/gh-stub";
import { initGitRepo } from "./lib/git-fixture";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.join(__dirname, "throughput-readout.js");
const SINCE = "2026-11-10T00:00:00Z";
const UNTIL = "2026-11-12T00:00:00Z";
const T0 = Date.parse(SINCE);
const MIN = 60_000;
const REPO = "owner/tracker";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "throughput-cli-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const at = (t: number) => new Date(t).toISOString();

/** A minute line a minute over the whole window, 3 sessions at load 4. */
function writeMinuteLog() {
	const lines = Array.from({ length: 48 * 60 }, (_, i) =>
		JSON.stringify({ ts: at(T0 + i * MIN), load1: 4, sessions: 3 }),
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
	const seat = path.join(dir, "seat");
	fs.mkdirSync(path.join(seat, "jobs"), { recursive: true });
	fs.mkdirSync(path.join(dir, "refill"), { recursive: true });
	const stub = stubGhRoutes(dir, routes);
	return runInProcess(
		SCRIPT,
		[
			"--owner",
			"owner",
			"--markers",
			dir,
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
				WFC_REFILL_DIR: path.join(dir, "refill"),
			},
		},
	);
}

/** A checkout whose default branch holds a commit citing #1 and its revert. */
function writeCheckout() {
	const code = path.join(dir, "code");
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
}

it("prints the bands as JSON, a reverted close subtracted through the checkout's log", () => {
	writeMinuteLog();
	writeCheckout();
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
	expect(out.load[0].band).toBe("<16");
});

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
	[["--since", "yesterday", "--until", UNTIL]],
	[["--since", UNTIL, "--until", SINCE]],
	[["--since", SINCE, "--until", UNTIL, "--era", "after"]],
	[["--since", SINCE, "--until", UNTIL, "--checkout", "nodir"]],
])("exits 2 on a bad argument: %j", (args) => {
	const r = run(args);
	expect(r.status).toBe(2);
	expect(r.stderr).toContain("usage:");
});
