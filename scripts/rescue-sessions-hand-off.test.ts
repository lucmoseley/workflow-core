// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	commitAll,
	freshSandbox,
	gitRepo,
	issueClaims,
	ledger,
} from "./lib/arbiter-testkit";
import { stubGhScript } from "./lib/gh-stub";
import { handOffFaults, parseHandOff } from "./lib/hand-off.js";
import {
	rescueKit,
	SCRIPT,
	SHORT,
	SID,
	said,
	withTracker,
} from "./lib/rescue-testkit";
import { runInProcessAsync } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";

const N = 621;
const sb = freshSandbox(withTracker);
const { plan, writeTranscript, jobState } = rescueKit(sb);

const commentFile = () => path.join(sb.dir, "comment.md");

const handOff = (extra: string[] = [], issues = [N]) => {
	const { env } = stubGhScript(
		sb.dir,
		`#!/bin/sh\n[ "$1 $2" = "issue comment" ] && cat > ${shellQuote(commentFile())}\nexit 0\n`,
	);
	return runInProcessAsync(
		SCRIPT,
		[
			"hand-off",
			"--from",
			plan(),
			"--job",
			SHORT,
			...extra,
			...issues.flatMap((n) => ["--issue", `${n}`]),
		],
		{
			cwd: sb.repo,
			env: { ...process.env, ...env, CLAUDE_PROJECT_DIR: sb.repo },
		},
	);
};

const stoppedSession = () => {
	gitRepo(sb);
	for (const f of ["x.js", "z.js"])
		fs.writeFileSync(path.join(sb.repo, f), "old\n");
	commitAll(sb);
	fs.writeFileSync(path.join(sb.repo, "x.js"), "new\n");
	fs.writeFileSync(path.join(sb.repo, "y.js"), "fresh\n");
	fs.writeFileSync(path.join(sb.repo, "z.js"), "theirs\n");
	for (const f of ["x.js", "y.js"])
		ledger.recordWrite(path.join(sb.repo, f), SID);
	writeTranscript([said("Running the suite.")]);
	jobState({
		state: "stopped",
		intent: `/implement ${N}`,
		name: "Implement 621",
		cwd: sb.repo,
	});
	issueClaims.claimIssue(N, { sessionId: SID });
};

describe("hand-off (#2659)", () => {
	it("posts a well-formed hand-off carrying the session's own diff, and releases its claim", async () => {
		stoppedSession();
		const r = await handOff();
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		const body = fs.readFileSync(commentFile(), "utf8");
		expect(handOffFaults(body)).toEqual([]);
		const h = parseHandOff(body);
		expect(h?.fields.Base).toBe(
			execFileSync("git", ["rev-parse", "HEAD"], { cwd: sb.repo })
				.toString()
				.trim(),
		);
		expect(h?.uncommitted.sort()).toEqual(["x.js", "y.js"]);
		expect(h?.diff).toContain("+new");
		expect(h?.diff).toContain("+fresh");
		expect(h?.diff).not.toContain("theirs");
		expect(body).toContain("A: Running the suite.");
		expect(issueClaims.readIssueClaims(N)).toEqual([]);
		expect(r.stdout).toContain(`released: its claim on #${N}`);
		expect(
			fs.existsSync(
				path.join(
					sb.repo,
					".claude",
					"tmp",
					"rescue",
					`${N}-${SHORT}`,
					"index.json",
				),
			),
		).toBe(true);
	});
});
