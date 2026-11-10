// @vitest-environment node
/*
 * claimByArbiter, the one spawn of the arbiter's `claim` (#4719): the stub's
 * argument order and each outcome against a stand-in, the warning against the
 * real arbiter in the testkit sandbox.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimByArbiter } from "./arbiter-claim";
import { arbiterCli, freshSandbox, live } from "./arbiter-testkit";
import { mkScratchDir } from "./git-fixture";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
});

/** A stand-in arbiter running `body` as sh, its path returned. */
function stub(body: string): string {
	const dir = mkScratchDir("arbiter-claim-");
	dirs.push(dir);
	const file = path.join(dir, "claim.sh");
	fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	return file;
}

describe("claimByArbiter", () => {
	it("hands the stand-in the subject, then the session, then --generator", () => {
		const claimCmd = stub('echo "$@" >&2');
		expect(
			claimByArbiter("docs/x.md", { claimCmd, session: "s1", generator: true }),
		).toEqual({ claimed: true, warning: "docs/x.md s1 --generator" });
	});

	it("is claimed with no warning where the arbiter is silent", () => {
		expect(claimByArbiter("docs/x.md", { claimCmd: stub("exit 0") })).toEqual({
			claimed: true,
		});
	});

	it("says why on a refusal, from its output or its exit code", () => {
		expect(
			claimByArbiter("docs/x.md", { claimCmd: stub("echo held >&2; exit 1") }),
		).toEqual({ claimed: false, why: "held" });
		expect(claimByArbiter("docs/x.md", { claimCmd: stub("exit 3") })).toEqual({
			claimed: false,
			why: "the arbiter exited 3",
		});
	});

	it("is not claimed where the arbiter outruns the timeout", () => {
		// The real clock: spawnSync's own timeout is what kills the stand-in.
		const r = claimByArbiter("docs/x.md", {
			claimCmd: stub("sleep 5"),
			timeoutMs: 100,
		});
		expect(r.claimed).toBe(false);
	});

	describe("against the real arbiter", () => {
		const sb = freshSandbox();

		it("is claimed, with the warning naming a live neighbour that holds the subject too", () => {
			vi.stubEnv("CLAUDE_CODE_SESSION_ID", "claim-writer");
			const file = path.join(sb.repo, "docs/x.md");
			live(sb, "claim-holder");
			expect(arbiterCli(sb).cli(["claim", file, "claim-holder"]).status).toBe(
				0,
			);
			const r = claimByArbiter(file, { cwd: sb.repo });
			expect(r.claimed).toBe(true);
			expect(r.claimed && r.warning).toContain("claim-holder");
		});
	});
});
