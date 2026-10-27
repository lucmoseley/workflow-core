// @vitest-environment node
/*
 * Pins findHungJobs's own-session skip.
 *
 * findHungJobs is called in-process, straight off a synthetic job list and
 * listing — the CLI-level fixtures in check-ghost-jobs.test.ts and
 * dispatch-sessions.test.ts already cover the shared silence/window logic
 * through the checker and the dispatcher; this file covers the one guarantee
 * neither of those exercises: a caller's OWN session never reads as hung on
 * its own re-read (mantahostels#2598's spec review, which found the CLI fixtures never
 * actually reach this branch — the checker's own-session test lists nobody
 * under the checker's own id, so it never gets far enough to need the skip).
 *
 * admission.js, pick-next.js and check-ghost-jobs.js all name hung jobs off
 * this call, so a loosened case lets a dispatcher report its own session as
 * hung on its own re-read.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findHungJobs } from "./hung-jobs";

const ORIGINAL_SESSION_ID = process.env.CLAUDE_CODE_SESSION_ID;

afterEach(() => {
	if (ORIGINAL_SESSION_ID === undefined)
		delete process.env.CLAUDE_CODE_SESSION_ID;
	else process.env.CLAUDE_CODE_SESSION_ID = ORIGINAL_SESSION_ID;
});

/** A "working" job record, silent since it was created — no transcript lookup
 * needed: its session names no transcript findTranscript can resolve, so every case
 * here falls on the transcript-less (short) window by construction. */
function workingJob(sessionId: string, agedMinutes: number) {
	return {
		seat: "/nonexistent",
		job: "job1",
		rec: {
			state: "working",
			sessionId,
			createdAt: new Date(Date.now() - agedMinutes * 60_000).toISOString(),
		},
	};
}

describe("findHungJobs — the own-session skip (mantahostels#2598)", () => {
	beforeEach(() => {
		process.env.CLAUDE_CODE_SESSION_ID = "self-session";
	});

	it("never calls its own caller's job hung, however long it has been silent", () => {
		const jobs = [workingJob("self-session", 500)];
		const listed = {
			ids: new Set(["self-session"]),
			pids: new Map([["self-session", 1]]),
		};
		expect(findHungJobs(jobs, listed)).toEqual([]);
	});

	it("still calls a DIFFERENT session's job hung under the same env", () => {
		const jobs = [workingJob("someone-else", 500)];
		const listed = {
			ids: new Set(["self-session", "someone-else"]),
			pids: new Map([
				["self-session", 1],
				["someone-else", 2],
			]),
		};
		expect(findHungJobs(jobs, listed)).toHaveLength(1);
	});
});
