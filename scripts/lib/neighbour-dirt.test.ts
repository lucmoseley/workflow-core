/**
 * neighbour-dirt.test.ts — `readClaimedElsewhere`'s judgement of whose claim
 * is live: a neighbour resumed onto a fresh host still holds its files (#4902).
 *
 * In-process, on arbiter-testkit's sandbox lock store and sessions registry,
 * so a lock's frozen pid and the registry's live one can disagree on purpose.
 * Broken, `guard-uncommitted-work.js` names a resumed neighbour's file as this
 * session's dirt, with a commit command that puts their bytes under its message.
 */

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
	DEAD,
	freshSandbox,
	gitRepo,
	liveHolder,
	putLock,
	registerSession,
} from "./arbiter-testkit";

const { readClaimedElsewhere } = createRequire(import.meta.url)(
	"./neighbour-dirt.js",
);

const sb = freshSandbox(gitRepo);

describe("readClaimedElsewhere", () => {
	it("names a path a live neighbour claims", () => {
		putLock("docs/b.md", { sessionId: "neighbour", ...liveHolder() });
		expect([...readClaimedElsewhere("me")]).toEqual(["docs/b.md"]);
	});

	it("passes over a claim whose holder ended", () => {
		putLock("docs/b.md", { sessionId: "neighbour", ...DEAD });
		expect([...readClaimedElsewhere("me")]).toEqual([]);
	});

	it("names a path whose holder's pid is dead but whose session the registry shows resumed (#4902)", () => {
		registerSession(sb, "neighbour", process.pid);
		putLock("docs/b.md", { sessionId: "neighbour", ...DEAD });
		expect([...readClaimedElsewhere("me")]).toEqual(["docs/b.md"]);
	});

	it("passes over this session's own claim", () => {
		putLock("docs/b.md", { sessionId: "me", ...liveHolder() });
		expect([...readClaimedElsewhere("me")]).toEqual([]);
	});
});
