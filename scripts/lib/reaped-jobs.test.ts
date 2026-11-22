// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { journalReapedJobs, readReaped } from "./reaped-jobs.js";

const readReapedJobs = () => readReaped(() => undefined).jobs;

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

const NOW = Date.parse("2026-11-17T03:00:00Z");

it("adds an entry, stamped with the run's clock, for each stopped row", () => {
	expect(journalReapedJobs([row], NOW)).toBeNull();
	expect(readReapedJobs()).toEqual([entry(NOW)]);
});

it("drops entries older than a day on its next write, and keeps the rest", () => {
	seed([entry(NOW - 25 * HOUR), entry(NOW - 23 * HOUR)]);
	journalReapedJobs([{ ...row, id: "f2" }], NOW);
	expect(readReapedJobs().map((e) => [e.jobId, e.at])).toEqual([
		["f1", NOW - 23 * HOUR],
		["f2", NOW],
	]);
});

it("adds no entry for a row that names no seat or cwd, and reads no malformed one", () => {
	const { cwd: _, ...noCwd } = row;
	seed([{ at: "x" }, null]);
	journalReapedJobs([noCwd], NOW);
	expect(readReapedJobs()).toEqual([]);
});

it("says why where the journal will not write", () => {
	const blocker = path.join(dir, "a-file");
	fs.writeFileSync(blocker, "");
	vi.stubEnv("WFC_REFILL_DIR", path.join(blocker, "sub"));
	expect(journalReapedJobs([row], NOW)).toEqual(expect.any(String));
});
