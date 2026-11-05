// @vitest-environment node
/*
 * Pins what pick-next decides about an issue the launcher already dispatched
 * (mantahostels#1528): which ledger entry holds it on its current `takes:`
 * value (#752), the launch's age as the exclusion reads it, and whether the
 * launch's own job is still alive (mantahostels#3488) — #4329.
 *
 * Loosen a case and a run offers an issue the launcher will drop at launch, or
 * prints a finished launch as live and a reader never chases it.
 *
 * Pure over seeded ledger entries, job records and an oracle listing; the
 * clock is passed in, so an age is asserted without wall time (§X9).
 */
import { describe, expect, it } from "vitest";

const {
	dispatchAge,
	dispatchLiveness,
	dispatchLivenessLabel,
	holdingDispatch,
} = require("./pick-next-dispatched.js");

const NOW = Date.parse("2026-11-05T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const entry = (over: Record<string, unknown> = {}) => ({
	ts: hoursAgo(0.2),
	issues: [2],
	model: "opus",
	prompt: "/implement 2",
	session: "launcher",
	jobId: null,
	...over,
});
const ledger = (...recs: ReturnType<typeof entry>[]) => ({
	byIssue: new Map([[2, recs]]),
});
const listed = (ids: string[], terminal: string[] = []) => ({
	ids: new Set(ids),
	names: new Map(),
	finished: new Set(),
	terminal: new Set(terminal),
	pids: new Map(),
});
const job = (id: string, rec: Record<string, unknown>) => ({
	seat: "s",
	job: id,
	rec,
});

describe("which ledger entry holds an issue (#752)", () => {
	it("names the launch that excluded it, with its age and prompt", () => {
		expect(
			dispatchAge(entry({ ts: hoursAgo(0.5), prompt: "/implement 2 7" }), NOW),
		).toBe("0.5h ago — /implement 2 7");
	});

	it("holds an issue carrying no takes: value, having nothing to compare", () => {
		const rec = entry({ prompt: "/triage 2" });
		expect(holdingDispatch(ledger(rec), 2, [])).toBe(rec);
		expect(holdingDispatch(ledger(rec), 2, ["wayfinder"])).toBeUndefined();
	});

	it("reads every entry on the issue, not only the latest", () => {
		const older = entry({ prompt: "/wayfinder 2", ts: hoursAgo(0.8) });
		const newer = entry({ prompt: "/triage 2", ts: hoursAgo(0.3) });
		const rec = holdingDispatch(ledger(older, newer), 2, ["wayfinder"]);
		expect(rec).toBe(older);
		expect(dispatchAge(rec, NOW)).toBe("0.8h ago — /wayfinder 2");
	});
});

describe("whether the dispatched launch's own job is still alive (mantahostels#3488)", () => {
	const jobs = [job("job1", { state: "done", sessionId: "worker1" })];

	it("reads finished: done off a job whose own state.json reads done", () => {
		// No oracle entry at all: a finished job can fall out of `claude agents
		// --json` on its own, and its own record is trusted outright.
		expect(
			dispatchLiveness(entry({ jobId: "job1" }), listed(["self"]), jobs),
		).toEqual({ state: "finished", detail: "done" });
	});

	it("prints finished: done in the text table", () => {
		expect(
			dispatchLivenessLabel(
				dispatchLiveness(entry({ jobId: "job1" }), listed(["self"]), jobs),
			),
		).toBe("finished: done");
	});

	it("reads finished off the oracle's own terminal state where the job record only says working", () => {
		const working = [job("job1", { state: "working", sessionId: "worker1" })];
		const rec = entry({ jobId: "job1" });
		expect(
			dispatchLiveness(rec, listed(["self", "worker1"], ["worker1"]), working),
		).toEqual({ state: "finished", detail: "oracle reads it terminal" });
		expect(dispatchLiveness(rec, listed(["self", "worker1"]), working)).toEqual(
			{ state: "live" },
		);
	});

	it("reads unknown, never live, on a pre-mantahostels#3488 entry with no job id", () => {
		expect(
			dispatchLiveness(entry(), listed(["self", "worker1"]), jobs),
		).toEqual({ state: "unknown", why: "no job id recorded on this entry" });
	});

	it("prints unknown, never live, in the text table on a pre-mantahostels#3488 entry with no job id", () => {
		expect(
			dispatchLivenessLabel(
				dispatchLiveness(entry(), listed(["self", "worker1"]), jobs),
			),
		).toBe("unknown");
	});

	it("reads unknown, never live, where the job id names no readable job record", () => {
		expect(
			dispatchLiveness(entry({ jobId: "ghost" }), listed(["self"]), jobs),
		).toEqual({ state: "unknown", why: "no job record found for ghost" });
	});
});
