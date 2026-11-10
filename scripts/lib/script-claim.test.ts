// @vitest-environment node
/*
 * claimByArbiter and releaseByArbiter, the one spawn of the arbiter's `claim`
 * and `release` (#4719): the stand-in's argument order and each outcome, the
 * warning against the real arbiter in the testkit sandbox. Every script that
 * writes a tracked file under its own claim goes through them, so a loosened
 * case lets a refused claim pass as taken, or loses the warning that a live
 * neighbour holds the file too.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { arbiterCli, freshSandbox, live } from "./arbiter-testkit";
import { mkScratchDir } from "./git-fixture";
import { claimByArbiter, releaseByArbiter } from "./script-claim";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
});

/** A stand-in arbiter running `body` as sh, its path returned. */
function stub(body: string): string {
	const dir = mkScratchDir("script-claim-");
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
		// The real clock: spawnSync's own timeout is what kills the stand-in. The
		// 100 ms limit sits fifty times under the 5 s sleep, so the kill is certain.
		const r = claimByArbiter("docs/x.md", {
			claimCmd: stub("sleep 5"),
			timeoutMs: 100,
		});
		expect(r.claimed).toBe(false);
	});

	it("releases with the subject, then --generator, and says why on a refusal", () => {
		expect(
			releaseByArbiter("docs/x.md", {
				releaseCmd: stub('[ "$*" = "docs/x.md --generator" ]'),
				generator: true,
			}),
		).toEqual({ released: true });
		expect(
			releaseByArbiter("docs/x.md", {
				releaseCmd: stub("echo dirty >&2; exit 1"),
			}),
		).toEqual({ released: false, why: "dirty" });
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
