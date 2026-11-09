// @vitest-environment node
/*
 * What `lib/session-id.js` answers, given an environment or a payload
 * (mantahostels#1774). Each case hands it one directly, in-process, so no case
 * depends on the session the suite runs in.
 *
 * `pick-next.js` mints a selection marker on one side and
 * `guard-selection-sum.js`, a Stop hook in `.claude/settings.json`, reads it on
 * the other; loosen a case and an empty or absent id keys a marker no session
 * reads, and the guard goes quiet.
 *
 * WHICH FUNCTION EACH SIDE CALLS IS NOT PINNED, here or anywhere. The seam is a
 * de-duplication device, so a call site that inlined the lookup again would
 * behave identically and no test could see the difference. What IS pinned is
 * each side's behaviour, in its own suite: the mint's, keyed on an injected
 * environment, in `guard-selection-sum.test.ts`; the reader's, keyed on the
 * payload field, in `hook-message.test.ts`. Watching the call itself would take
 * patching a live export, which §X2 bars.
 */

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

	/* Empty is null, not `""`: a marker path built from `""` would collide with
	 * every other id-less run. */
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

/* An outliving job is no session, yet its reports are owed to its starter
 * (#4706); loosen the order and a daily run's report reaches nobody. */
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

/* The ledger's `lander` kind rests on this mark alone (#4757). */
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
