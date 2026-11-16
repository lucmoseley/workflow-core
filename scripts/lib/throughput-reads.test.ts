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
import {
	readBreakerRecord,
	readMainCommits,
	readSessionTimeline,
} from "./throughput-reads.js";

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

describe("readMainCommits", () => {
	it("reads origin/main's non-merge commits since a time, with their commit times, and no other branch's", () => {
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
		const shas = readMainCommits(repo, 0)?.map((c) => c.sha);
		expect(shas).toContain(two);
		expect(shas).toHaveLength(3);
		expect(shas).not.toContain(git(repo, "rev-parse", "HEAD~1"));
		expect(readMainCommits(repo, Date.now() + 3_600_000)).toEqual([]);
		const at = readMainCommits(repo, 0)?.[0]?.at ?? 0;
		expect(Math.abs(at - Date.now())).toBeLessThan(60_000);
	});

	it("is null where git will not answer", () => {
		expect(readMainCommits(path.join(tmp, "none"), 0)).toBeNull();
	});
});

describe("the breaker's record", () => {
	it("reads back what was appended, and none where it is absent", () => {
		expect(readBreakerRecord()).toEqual([]);
		const event = {
			at: new Date().toISOString(),
			repo: "/r",
			event: "open" as const,
			rate: 0.1,
			workingHours: 13,
		};
		appendBreakerEvents([event], () => undefined);
		expect(readBreakerRecord()).toEqual([event]);
	});

	it("is null where it will not read", () => {
		fs.mkdirSync(path.join(tmp, "refill", ".refill-breaker.jsonl"));
		expect(readBreakerRecord()).toBeNull();
	});
});

describe("readSessionTimeline", () => {
	it("reads a job's state rows, its end its finish or now", () => {
		const seat = path.join(tmp, "seat");
		const dir = path.join(seat, "jobs", "j1");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "timeline.jsonl"),
			`${JSON.stringify({ at: "2026-11-15T10:00:00Z", state: "working", detail: "", text: "" })}\n{"at":1}\n`,
		);
		const l = {
			root: "/r",
			issues: [1],
			jobId: "j1",
			sessionId: "s",
			launchedAt: 0,
			finishedAt: null,
			seat,
		};
		expect(readSessionTimeline(l, 5)).toEqual({
			rows: [{ at: "2026-11-15T10:00:00Z", state: "working" }],
			endAt: 5,
		});
		expect(readSessionTimeline({ ...l, jobId: "gone" }, 5)).toEqual({
			rows: [],
			endAt: 5,
		});
	});
});
