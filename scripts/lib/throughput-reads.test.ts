// @vitest-environment node
/*
 * lib/throughput-reads.js — the throughput breaker's reads (#5275), crossed for
 * real: git and the files in the test's own temp directory. Broken, the
 * breaker counts merges or another branch's commits as landings, or reads an
 * unreadable record as an empty one and closes a breaker it should hold.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendBreakerEvents } from "./refill-breaker.js";
import { readThroughput, readThroughputWindow } from "./throughput-reads.js";

type SeatedLaunch = import("./refill-breaker.js").BreakerLaunch & {
	seat: string;
};

/** The read a tick takes of `root`, reaching back to `since`. */
const tickRead = (root: string, since = 0) =>
	readThroughput([root], () => since, Date.now());

let tmp: string;
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "throughput-reads-"));
	fs.mkdirSync(path.join(tmp, "refill"));
	vi.stubEnv("WFC_REFILL_DIR", path.join(tmp, "refill"));
});
afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("a checkout's origin/main commits", () => {
	it("reads origin/main's non-merge commits since a time, with their commit times, and none origin/main lacks", () => {
		const repo = path.join(tmp, "repo");
		fs.mkdirSync(repo);
		git(repo, "init", "-q", "-b", "main");
		git(repo, "config", "user.email", "test@example.com");
		git(repo, "config", "user.name", "test");
		git(repo, "commit", "-q", "--allow-empty", "-m", "one");
		git(repo, "checkout", "-q", "-b", "side");
		git(repo, "commit", "-q", "--allow-empty", "-m", "side");
		git(repo, "checkout", "-q", "main");
		git(repo, "commit", "-q", "--allow-empty", "-m", "two");
		git(repo, "merge", "-q", "--no-ff", "-m", "merge", "side");
		git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
		git(repo, "commit", "-q", "--allow-empty", "-m", "unpushed");
		const two = git(repo, "rev-parse", "HEAD~1^1");
		const commits = tickRead(repo).byRoot[repo]?.commits;
		const shas = commits?.map((c) => c.sha);
		expect(shas).toContain(two);
		expect(shas).toHaveLength(3);
		expect(shas).not.toContain(git(repo, "rev-parse", "HEAD~1"));
		expect(
			tickRead(repo, Date.now() + 3_600_000).byRoot[repo]?.commits,
		).toEqual([]);
		const at = commits?.[0]?.at ?? 0;
		expect(Math.abs(at - Date.now())).toBeLessThan(60_000);
	});

	it("is null where git will not answer", () => {
		const none = path.join(tmp, "none");
		expect(tickRead(none).byRoot[none]?.commits).toBeNull();
	});
});

describe("the breaker's record", () => {
	it("reads back what was appended, and none where it is absent", () => {
		expect(tickRead(tmp).record).toEqual([]);
		const event = {
			at: new Date().toISOString(),
			repo: "/r",
			event: "open" as const,
			rate: 0.1,
			workingHours: 13,
		};
		appendBreakerEvents([event], () => undefined);
		expect(tickRead(tmp).record).toEqual([event]);
	});

	it("is null where it will not read", () => {
		fs.mkdirSync(path.join(tmp, "refill", ".refill-breaker.jsonl"));
		expect(tickRead(tmp).record).toBeNull();
	});
});

describe("a loop session's job timeline", () => {
	it("reads a job's state rows, its end its finish or now", () => {
		const seat = path.join(tmp, "seat");
		const dir = path.join(seat, "jobs", "j1");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "timeline.jsonl"),
			`${JSON.stringify({ at: "2026-11-15T10:00:00Z", state: "working", detail: "", text: "" })}\n{"at":1}\n`,
		);
		const l: SeatedLaunch = {
			root: "/r",
			issues: [1],
			jobId: "j1",
			sessionId: "s",
			launchedAt: 0,
			finishedAt: null,
			seat,
		};
		const { timelineOf } = readThroughput([], () => 0, 5);
		expect(timelineOf(l)).toEqual({
			rows: [{ at: "2026-11-15T10:00:00Z", state: "working" }],
			endAt: 5,
		});
		expect(timelineOf({ ...l, jobId: "gone" } as SeatedLaunch)).toEqual({
			rows: [],
			endAt: 5,
		});
	});
});

describe("readThroughputWindow", () => {
	it("reads a served checkout's window: its sessions' hours, its breaker at the end, the window's events", () => {
		const Hour = 3_600_000;
		const hi = Date.parse("2026-11-16T07:00:00Z");
		const lo = hi - 24 * Hour;
		const seat = path.join(tmp, "seat");
		const row = (at: number) =>
			JSON.stringify({ at: new Date(at).toISOString(), state: "working" });
		for (const [id, start] of [
			["in", hi - 2 * Hour],
			["before", lo - 3 * Hour],
		] as const) {
			fs.mkdirSync(path.join(seat, "jobs", id), { recursive: true });
			fs.writeFileSync(
				path.join(seat, "jobs", id, "timeline.jsonl"),
				`${row(start)}\n${row(start + 30 * 60_000)}\n`,
			);
		}
		const launch = (jobId: string, launchedAt: number, root = "/srv/dv") => ({
			root,
			issues: [1],
			jobId,
			sessionId: jobId,
			launchedAt,
			finishedAt: launchedAt + Hour,
			seat,
		});
		const ev = (at: number, event: "open" | "reopen", repo = "/srv/dv") => ({
			at: new Date(at).toISOString(),
			repo,
			event,
			rate: 0.1,
			workingHours: 13,
		});
		appendBreakerEvents(
			[
				ev(lo - Hour, "open"),
				ev(hi - Hour, "reopen"),
				ev(hi - Hour, "open", "/srv/other"),
			],
			() => undefined,
		);
		const [dv] = readThroughputWindow({
			roots: ["/srv/dv"],
			launches: [
				launch("in", hi - 2 * Hour),
				launch("before", lo - 3 * Hour),
				launch("in", hi - 2 * Hour, "/srv/other"),
			],
			lo,
			hi,
		});
		expect(dv).toEqual({
			checkout: "dv",
			commits: null,
			workingHours: 1,
			gateRuns: null,
			state: { state: "open", since: hi - Hour },
			events: [ev(hi - Hour, "reopen")],
		});
	});
});
