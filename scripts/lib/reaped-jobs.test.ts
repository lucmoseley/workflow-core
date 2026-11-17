// @vitest-environment node
/*
 * Pins lib/reaped-jobs.js's journal of the jobs the reaper stopped (#5331):
 * each stopped row the loop could resume becomes an entry stamped with its
 * write, and entries past the keep window drop. Loosen it and the loop either
 * misses a reaped session it could resume or reads a journal that only grows.
 */
import { expect, it } from "vitest";
import { withReaped } from "./reaped-jobs.js";

const NOW = 1_792_324_800_000;
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

it("adds an entry, stamped with its write, for each stopped row", () => {
	expect(withReaped([], [row], NOW)).toEqual([entry(NOW)]);
});

it("drops entries older than a day, and keeps the rest", () => {
	expect(
		withReaped([entry(NOW - 25 * HOUR), entry(NOW - 23 * HOUR)], [], NOW),
	).toEqual([entry(NOW - 23 * HOUR)]);
});

it("adds no entry for a row that names no seat or cwd, and keeps no malformed one", () => {
	const { cwd: _, ...noCwd } = row;
	expect(withReaped([{ at: "x" }, null], [noCwd], NOW)).toEqual([]);
});
