// @vitest-environment node
/*
 * Pins latest-timings.js (#4579): the newest green run's timings cached once
 * per source run under the git common dir, checked at most every 6 hours and
 * retried half an hour after a failure, the held file read until its last
 * passed check is a day old and none after, and the named file or none where
 * `WFC_SHARD_TIMINGS` or `CI` is set.
 *
 * WHAT BREAKING THIS COSTS: the lander's shards and the run-cost report would
 * pack and judge by timings days old, the fault #4579 closed, or fetch for
 * 10 s on every local run.
 *
 * GitHub comes in through `latestTimings`'s `fetch` seam and time through its
 * `now`, so no case reaches the network or the clock (§X9). git is real, in a
 * throwaway repository per case.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { latestTimings } from "./latest-timings.js";

let repo: string;
let cache: string;

beforeEach(() => {
	repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "latest-t-")));
	execFileSync("git", ["init", "-q"], { cwd: repo });
	cache = path.join(repo, ".git", "workflow-core", "suite-timings");
	vi.stubEnv("WFC_SHARD_TIMINGS", "");
	vi.stubEnv("CI", "");
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

const T0 = Date.parse("2026-11-09T00:00:00Z");
const HOUR = 60 * 60 * 1000;
/* latest-timings.js's windows, spelt here so a change to one fails a case. */
const CHECK_MS = 6 * HOUR;
const RETRY_MS = HOUR / 2;
const STALE_MS = 24 * HOUR;
const row = (seconds: number) => [
	{ file: "a.test.ts", seconds, tests: 1, status: "passed" },
];

/** A GitHub whose newest green run is `run`, recording each call's `held`
 * answer for that run. */
const github = (run: number, rows = row(2)) => {
	const calls: boolean[] = [];
	return {
		calls,
		fetch: (_root: string, _now: number, held: (r: number) => boolean) => {
			const have = held(run);
			calls.push(have);
			return { run, sha: `sha${run}`, rows: have ? null : rows };
		},
	};
};

describe("latestTimings", () => {
	it("fetches the newest run into a file of its own under the git common dir", () => {
		const gh = github(7);
		expect(latestTimings(repo, { now: T0, fetch: gh.fetch })).toEqual({
			file: path.join(cache, "7.csv"),
			failed: null,
		});
		expect(fs.readFileSync(path.join(cache, "7.csv"), "utf8")).toBe(
			"# run: 7\n# sha: sha7\nfile,seconds,tests,status\na.test.ts,2.00,1,passed\n",
		);
	});

	it("checks again only once CHECK_MS has passed, and downloads no run it holds", () => {
		const gh = github(7);
		latestTimings(repo, { now: T0, fetch: gh.fetch });
		latestTimings(repo, { now: T0 + CHECK_MS - 1, fetch: gh.fetch });
		expect(gh.calls).toEqual([false]);
		latestTimings(repo, { now: T0 + CHECK_MS, fetch: gh.fetch });
		expect(gh.calls).toEqual([false, true]);
	});

	it("moves to a newer run and keeps the older file, so a reader already handed it still reads it", () => {
		latestTimings(repo, { now: T0, fetch: github(7).fetch });
		expect(
			latestTimings(repo, { now: T0 + CHECK_MS, fetch: github(9).fetch }).file,
		).toBe(path.join(cache, "9.csv"));
		expect(fs.existsSync(path.join(cache, "7.csv"))).toBe(true);
	});

	it("keeps only the newest five runs", () => {
		for (let run = 1; run <= 7; run++)
			latestTimings(repo, {
				now: T0 + run * CHECK_MS,
				fetch: github(run).fetch,
			});
		expect(
			fs
				.readdirSync(cache)
				.filter((f) => f.endsWith(".csv"))
				.sort(),
		).toEqual(["3.csv", "4.csv", "5.csv", "6.csv", "7.csv"]);
	});

	const failing = () => {
		throw new Error("HTTP 502: Bad Gateway");
	};

	it("reads the held file where the check fails, saying why, and retries half an hour later", () => {
		latestTimings(repo, { now: T0, fetch: github(7).fetch });
		expect(latestTimings(repo, { now: T0 + CHECK_MS, fetch: failing })).toEqual(
			{ file: path.join(cache, "7.csv"), failed: "HTTP 502: Bad Gateway" },
		);
		const gh = github(8);
		latestTimings(repo, {
			now: T0 + CHECK_MS + RETRY_MS - 1,
			fetch: gh.fetch,
		});
		expect(gh.calls).toEqual([]);
		expect(
			latestTimings(repo, { now: T0 + CHECK_MS + RETRY_MS, fetch: gh.fetch })
				.file,
		).toBe(path.join(cache, "8.csv"));
	});

	it("reads none once the last passed check is a day old, though a file is held", () => {
		latestTimings(repo, { now: T0, fetch: github(7).fetch });
		expect(
			latestTimings(repo, { now: T0 + STALE_MS - 1, fetch: failing }).file,
		).toBe(path.join(cache, "7.csv"));
		expect(latestTimings(repo, { now: T0 + STALE_MS, fetch: failing })).toEqual(
			{ file: null, failed: "the last passed check is a day old" },
		);
		expect(
			latestTimings(repo, { now: T0 + STALE_MS + RETRY_MS, fetch: failing }),
		).toEqual({ file: null, failed: "HTTP 502: Bad Gateway" });
	});

	it("reads none where nothing is held and no green run holds reports", () => {
		expect(latestTimings(repo, { now: T0, fetch: () => null })).toEqual({
			file: null,
			failed: "no green suite run holds reports",
		});
	});

	it("shares one cache across the repository's worktrees", () => {
		execFileSync(
			"git",
			[
				"-c",
				"user.name=t",
				"-c",
				"user.email=t@t",
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				"base",
			],
			{ cwd: repo },
		);
		const linked = path.join(repo, "linked");
		execFileSync("git", ["worktree", "add", "-q", linked], { cwd: repo });
		latestTimings(repo, { now: T0, fetch: github(7).fetch });
		const gh = github(7);
		expect(latestTimings(linked, { now: T0 + 1, fetch: gh.fetch }).file).toBe(
			path.join(cache, "7.csv"),
		);
		expect(gh.calls).toEqual([]);
	});

	it("reads the file WFC_SHARD_TIMINGS names, and none where it is absent, fetching nothing", () => {
		const named = path.join(repo, "named.csv");
		fs.writeFileSync(named, "file,seconds,tests,status\n");
		const gh = github(7);
		vi.stubEnv("WFC_SHARD_TIMINGS", named);
		expect(latestTimings(repo, { now: T0, fetch: gh.fetch })).toEqual({
			file: named,
			failed: null,
		});
		vi.stubEnv("WFC_SHARD_TIMINGS", path.join(repo, "absent.csv"));
		expect(latestTimings(repo, { now: T0, fetch: gh.fetch }).file).toBeNull();
		expect(gh.calls).toEqual([]);
	});

	it("fetches nothing under CI where no file is named", () => {
		vi.stubEnv("CI", "true");
		const gh = github(7);
		expect(latestTimings(repo, { now: T0, fetch: gh.fetch })).toEqual({
			file: null,
			failed: null,
		});
		expect(gh.calls).toEqual([]);
	});
});
