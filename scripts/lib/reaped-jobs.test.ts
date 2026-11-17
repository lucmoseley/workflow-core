// @vitest-environment node
/*
 * Pins lib/reaped-jobs.js's journal of the jobs the reaper stopped (#5331):
 * each stopped row the loop could resume becomes an entry stamped with its
 * write, and entries past the keep window drop. Loosen it and the loop either
 * misses a reaped session it could resume or reads a journal that only grows.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { journalReapedJobs, readReapedJobs } from "./reaped-jobs.js";

const HOUR = 60 * 60_000;
const row = {
	id: "f1",
	sessionId: "sess-f1",
	name: "founder-session",
	seat: "/home/u/.claude",
	cwd: "/home/u/work",
};
const entry = (at: number) => ({
	at,
	seat: row.seat,
	jobId: row.id,
	sessionId: row.sessionId,
	name: row.name,
	cwd: row.cwd,
});

let dir = "";
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "reaped-jobs-"));
	vi.stubEnv("WFC_REFILL_DIR", dir);
});
afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(dir, { recursive: true, force: true });
});
const seed = (list: unknown[]) =>
	fs.writeFileSync(path.join(dir, ".reaped-jobs.json"), JSON.stringify(list));

it("adds an entry, stamped with its write, for each stopped row", () => {
	const before = Date.now();
	expect(journalReapedJobs([row])).toBeNull();
	const [e] = readReapedJobs();
	expect(e).toEqual({ ...entry(e.at) });
	expect(e.at).toBeGreaterThanOrEqual(before);
});

it("drops entries older than a day on its next write, and keeps the rest", () => {
	const now = Date.now();
	seed([entry(now - 25 * HOUR), entry(now - 23 * HOUR)]);
	journalReapedJobs([{ ...row, id: "f2" }]);
	expect(readReapedJobs().map((e) => [e.jobId, e.at])).toEqual([
		["f1", now - 23 * HOUR],
		["f2", expect.any(Number)],
	]);
});

it("adds no entry for a row that names no seat or cwd, and reads no malformed one", () => {
	const { cwd: _, ...noCwd } = row;
	seed([{ at: "x" }, null]);
	journalReapedJobs([noCwd]);
	expect(readReapedJobs()).toEqual([]);
});

it("says why where the journal will not write", () => {
	const blocker = path.join(dir, "a-file");
	fs.writeFileSync(blocker, "");
	vi.stubEnv("WFC_REFILL_DIR", path.join(blocker, "sub"));
	expect(journalReapedJobs([row])).toEqual(expect.any(String));
});
