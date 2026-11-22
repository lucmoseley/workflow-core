// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

const sessionId = require("./session-id.js");

describe("the minting side reads the Bash environment", () => {
	it("returns CLAUDE_CODE_SESSION_ID", () => {
		expect(sessionId.fromEnv({ CLAUDE_CODE_SESSION_ID: "sess-a" })).toBe(
			"sess-a",
		);
	});

	it("returns null when it is unset", () => {
		expect(sessionId.fromEnv({})).toBe(null);
	});

	it("returns null when it is empty", () => {
		expect(sessionId.fromEnv({ CLAUDE_CODE_SESSION_ID: "" })).toBe(null);
	});

	it("defaults to this process's environment", () => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "sess-from-process");
		expect(sessionId.fromEnv()).toBe("sess-from-process");
	});
});

describe("the reading side reads the hook payload", () => {
	it("returns the payload's session_id", () => {
		expect(sessionId.fromPayload({ session_id: "sess-b" })).toBe("sess-b");
	});

	it("returns null for a payload carrying none", () => {
		expect(sessionId.fromPayload({})).toBe(null);
	});

	it("returns null for no payload at all", () => {
		expect(sessionId.fromPayload(null)).toBe(null);
		expect(sessionId.fromPayload(undefined)).toBe(null);
	});
});

describe("the report owner", () => {
	it("is the carried owner, ahead of the session id", () => {
		expect(
			sessionId.reportOwner({
				WFC_REPORT_OWNER: "starter",
				CLAUDE_CODE_SESSION_ID: "own",
			}),
		).toBe("starter");
	});

	it("is the session id where no owner is carried", () => {
		expect(sessionId.reportOwner({ CLAUDE_CODE_SESSION_ID: "own" })).toBe(
			"own",
		);
	});

	it("is null where neither is set", () => {
		expect(sessionId.reportOwner({ WFC_REPORT_OWNER: "" })).toBe(null);
	});
});

describe("isLanderRun", () => {
	it("is true only where the tester's mark is set", () => {
		expect(sessionId.isLanderRun({ WFC_LANDER_RUN: "1" })).toBe(true);
		expect(sessionId.isLanderRun({ WFC_LANDER_RUN: "" })).toBe(false);
		expect(sessionId.isLanderRun({})).toBe(false);
	});
});

describe("forgetSession", () => {
	it("strips the session id, job dir and report owner, and nothing else", () => {
		const env: Record<string, string | undefined> = {
			CLAUDE_CODE_SESSION_ID: "own",
			CLAUDE_JOB_DIR: "/jobs/x",
			WFC_REPORT_OWNER: "starter",
			CLAUDE_PID: "5000",
		};
		sessionId.forgetSession(env);
		expect(env).toEqual({ CLAUDE_PID: "5000" });
		expect(sessionId.reportOwner(env)).toBe(null);
	});
});
