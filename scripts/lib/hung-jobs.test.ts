// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findHungJobs } from "./hung-jobs";

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
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "self-session");
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
