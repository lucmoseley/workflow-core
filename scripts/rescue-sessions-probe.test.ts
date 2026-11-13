// @vitest-environment node
/*
 * rescue-sessions-probe.test.ts — `rescue-sessions.js probe` through its
 * command line (#620, spec #617): the boundary set lib/rescue-probe.js's
 * module cases (lib/rescue-probe.test.ts) leave to the program (#5157) — a
 * probe across the real oracle adapter, `gh` and WFC_PROC, a refusal, and the
 * oracle's failure, each through the shell's exit.
 *
 * Fixtures: scripts/lib/rescue-testkit.ts. The real script runs in a sandbox
 * against the kit's fake `claude` oracle, fake `gh` and fabricated `/proc`
 * (WFC_PROC), so no live session is ever sampled.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox, issueClaims } from "./lib/arbiter-testkit";
import {
	EXIT,
	holderRow,
	PID,
	rescueKit,
	SID,
	said,
	withTracker,
} from "./lib/rescue-testkit";

const sb = freshSandbox(withTracker);
const { plan, lists, proc, writeTranscript, jobState, run } = rescueKit(sb);

/**
 * The common case: listed working on the first plan, a transcript whose turn
 * ended on `waiting:`, nothing in flight, and a process tree that idles.
 */
const frozenHolder = () => {
	lists([holderRow()]);
	writeTranscript([said("Delegated the suite.\n\nwaiting: the suite run")]);
	jobState({ inFlight: { tasks: 0, queued: 0 } });
	proc(PID, 1, 1000, "claude");
	issueClaims.claimIssue(620, { sessionId: SID });
};

const probe = (args: string[] = ["--issue", "620"]) => run("probe", args);

const verdictOf = (r: { stdout: string }) => r.stdout.split(/\s/)[0];

describe("probe through the program: the shell's exit paths", () => {
	it("UNKNOWN when the only plan's oracle will not read", async () => {
		frozenHolder();
		fs.writeFileSync(path.join(plan(), "fail"), "");
		const r = await probe();
		expect(verdictOf(r)).toBe("UNKNOWN");
		expect(r.status).toBe(EXIT.UNKNOWN);
		expect(r.stdout).toContain("the listing would not read");
	});

	it("FROZEN when the lost wake left a waiting: turn with nothing running", async () => {
		frozenHolder();
		const r = await probe();
		expect(verdictOf(r)).toBe("FROZEN");
		expect(r.status).toBe(EXIT.FROZEN);
		expect(r.stdout).toContain("lost wake");
	});

	it("says there is nothing to probe where no other session claims the issue", async () => {
		frozenHolder();
		const r = await probe(["--issue", "999"]);
		expect(r.status).toBe(EXIT.REFUSED);
		expect(r.stderr).toContain("nothing to probe");
	});
});
