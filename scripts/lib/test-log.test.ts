// @vitest-environment node
/*
 * test-log.js's naming and its reap policy (mantahostels#1943): the only bound on a
 * per-run store that would otherwise grow by one file every `npm run test`.
 *
 * Naming is asserted on pure path strings, and the reap on a temp directory of
 * fabricated logs, so no case touches this checkout's own log store. Loosen a
 * case and two concurrent runs can write one log, or the store under
 * `.claude/tmp/markers` — which the scratch sweep never trims — grows unbounded.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const { dirPath, logPath, reap, runsPath, recordRun, readRuns }: any =
	require("./test-log.js");

describe("naming a per-run log so two runs never collide", () => {
	it("puts the log directory straight under the given root", () => {
		expect(dirPath("/repo")).toBe(
			path.join("/repo", ".claude", "tmp", "markers", ".test-logs"),
		);
	});

	it("names the sha, the start time and the pid, so two runs never collide", () => {
		const started = new Date("2026-08-29T12:34:56.789Z");
		const p = logPath("/repo", "abc123", started, 4242);
		expect(p.startsWith(dirPath("/repo"))).toBe(true);
		expect(path.basename(p)).toContain("abc123");
		expect(path.basename(p)).toContain("4242");
		// No raw colons: some tools choke on them in a filename.
		expect(path.basename(p)).not.toContain(":");
	});

	it("gives two runs on the same sha, same millisecond, different pids distinct paths", () => {
		const started = new Date("2026-08-29T12:34:56.789Z");
		const a = logPath("/repo", "abc123", started, 111);
		const b = logPath("/repo", "abc123", started, 222);
		expect(a).not.toBe(b);
	});
});

describe("bounding a store nothing else trims (mantahostels#1943)", () => {
	const dirs: string[] = [];

	afterEach(() => {
		while (dirs.length > 0)
			fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
	});

	function tmpDir() {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-log-reap-"));
		dirs.push(dir);
		return dir;
	}

	/** Writes `n` .log files with strictly increasing mtimes, oldest first. */
	function seed(dir: string, n: number) {
		const names: string[] = [];
		for (let i = 0; i < n; i++) {
			const p = path.join(dir, `run-${i}.log`);
			fs.writeFileSync(p, "x");
			const t = new Date(2026, 0, 1, 0, 0, i);
			fs.utimesSync(p, t, t);
			names.push(p);
		}
		return names;
	}

	it("leaves a directory at or under the keep count untouched", () => {
		const dir = tmpDir();
		seed(dir, 3);
		expect(reap(dir, { keep: 5 })).toEqual([]);
		expect(fs.readdirSync(dir)).toHaveLength(3);
	});

	it("keeps the newest 30 runs where no count is given", () => {
		const dir = tmpDir();
		const names = seed(dir, 31);
		expect(reap(dir)).toEqual([names[0]]);
		expect(fs.readdirSync(dir)).toHaveLength(30);
	});

	it("evicts the oldest logs first, keeping exactly `keep`", () => {
		const dir = tmpDir();
		const names = seed(dir, 5);
		const removed = reap(dir, { keep: 2 });
		expect(removed.sort()).toEqual([names[0], names[1], names[2]].sort());
		expect(fs.readdirSync(dir).sort()).toEqual(
			["run-3.log", "run-4.log"].sort(),
		);
	});

	it("never touches a file that is not a .log", () => {
		const dir = tmpDir();
		seed(dir, 1);
		fs.writeFileSync(path.join(dir, "keepme.txt"), "x");
		reap(dir, { keep: 0 });
		expect(fs.existsSync(path.join(dir, "keepme.txt"))).toBe(true);
	});

	it("reports no removals, never throws, on a directory that does not exist", () => {
		expect(reap("/does/not/exist", { keep: 0 })).toEqual([]);
	});

	it("survives a delete failure on one entry and still removes the rest", () => {
		const dir = tmpDir();
		const names = seed(dir, 3);
		const fsImpl = {
			readdirSync: fs.readdirSync,
			statSync: fs.statSync,
			unlinkSync: (p: string) => {
				if (p === names[0]) throw Object.assign(new Error("EBUSY"), {});
				fs.unlinkSync(p);
			},
		};
		const removed = reap(dir, { keep: 0, fs: fsImpl });
		// The one that threw is not reported removed, but is not fatal either.
		expect(removed).not.toContain(names[0]);
		expect(removed).toContain(names[1]);
		expect(removed).toContain(names[2]);
	});

	it("drops a session's run record last written before the oldest kept log, and keeps a newer one", () => {
		const dir = tmpDir();
		const names = seed(dir, 3);
		const stale = path.join(dir, "runs-old.jsonl");
		const live = path.join(dir, "runs-new.jsonl");
		for (const [p, s] of [
			[stale, 0],
			[live, 2],
		] as const) {
			fs.writeFileSync(p, "{}\n");
			const t = new Date(2026, 0, 1, 0, 0, s);
			fs.utimesSync(p, t, t);
		}
		const removed = reap(dir, { keep: 2 });
		expect(removed).toEqual([names[0], stale]);
		expect(fs.existsSync(live)).toBe(true);
	});
});

describe("a session's record of its finished runs (#1575)", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const r of roots.splice(0))
			fs.rmSync(r, { recursive: true, force: true });
	});
	const root = () => {
		const r = fs.mkdtempSync(path.join(os.tmpdir(), "test-log-runs-"));
		roots.push(r);
		fs.mkdirSync(dirPath(r), { recursive: true });
		return r;
	};
	const run = (log: string, pid: number) => ({
		log,
		pid,
		startedAt: "2026-10-14T09:00:00.000Z",
		endedAt: "2026-10-14T09:01:00.000Z",
	});

	it("keeps it beside the logs, one file per session", () => {
		expect(path.dirname(runsPath("/repo", "s1"))).toBe(dirPath("/repo"));
		expect(runsPath("/repo", "s1")).not.toBe(runsPath("/repo", "s2"));
		expect(runsPath("/repo", "s1").endsWith(".log")).toBe(false);
	});

	it("reads back every run appended, oldest first, and no other session's", () => {
		const r = root();
		expect(recordRun(r, "s1", run("/a.log", 1))).toBe(true);
		recordRun(r, "s2", run("/b.log", 2));
		recordRun(r, "s1", run("/c.log", 3));
		expect(readRuns(r, "s1").map((x: { log: string }) => x.log)).toEqual([
			"/a.log",
			"/c.log",
		]);
	});

	it("skips a malformed line and reads a missing record as none", () => {
		const r = root();
		expect(readRuns(r, "s1")).toEqual([]);
		recordRun(r, "s1", run("/a.log", 1));
		fs.appendFileSync(runsPath(r, "s1"), '{"log": "/cut\n');
		expect(readRuns(r, "s1")).toHaveLength(1);
	});

	it("reports a record it could not write, never throws", () => {
		expect(recordRun("/does/not/exist", "s1", run("/a.log", 1))).toBe(false);
	});
});
