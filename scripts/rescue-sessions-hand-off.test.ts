// @vitest-environment node
/*
 * `rescue-sessions.js hand-off`, the refill loop's takeover of a resumed-idle
 * session it stopped (#2659), driven through its command line in a sandbox
 * holding a real git repo and arbiter store, against a fake `gh`.
 *
 * Breaking it costs the fresh session its pick-up: a comment read-hand-off.js
 * passes over, a diff carrying a neighbour's file, a known session's claim left
 * standing, or the stopped session's files restored out from under it. Of a job
 * whose record is gone (#3988), it costs the warning that the old session may
 * have been waiting on the founder.
 */

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
import { doneShas, handOffFaults, parseHandOff } from "./lib/hand-off.js";
import { BOOT_PROMPT, scriptPrompt } from "./lib/loop-prompts.js";
import {
	rescueKit,
	SCRIPT,
	SHORT,
	SID,
	said,
	withTracker,
} from "./lib/rescue-testkit";
import { runInProcess } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";

const N = 621;
const sb = freshSandbox(withTracker);
const { plan, writeTranscript, jobState } = rescueKit(sb);

const commentFile = () => path.join(sb.dir, "comment.md");
const commentedFile = () => path.join(sb.dir, "commented");

/** `hand-off` for #621 on the sandbox plan, `gh` saving the comment body. */
const handOff = (extra: string[] = [], issues = [N]) => {
	const { env } = stubGhScript(
		sb.dir,
		`#!/bin/sh\n[ "$1 $2" = "issue comment" ] && { echo "$3" >> ${shellQuote(commentedFile())}; cat > ${shellQuote(commentFile())}; }\nexit 0\n`,
	);
	return runInProcess(
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

/** A repo whose stopped session left x.js edited and y.js new, beside a
 * neighbour's z.js it never wrote, claiming #621. */
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
	it("posts a well-formed hand-off carrying the session's own diff, and releases its claim", () => {
		stoppedSession();
		const r = handOff();
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

	it("tells the fresh session to build nothing past a question the narration ends on, reading past the loop's own prompts (#3980)", () => {
		stoppedSession();
		writeTranscript([
			said("Shall we ship it?"),
			JSON.stringify({ type: "user", message: { content: BOOT_PROMPT } }),
			JSON.stringify({
				type: "user",
				message: { content: scriptPrompt("carry on") },
			}),
		]);
		handOff();
		const body = fs.readFileSync(commentFile(), "utf8");
		expect(parseHandOff(body)?.fields.Left).toContain(
			"unless they end on a question to the founder that this ticket does not show answered",
		);
		expect(body).toContain("A: Shall we ship it?");
		expect(body).not.toContain("USER: [refill loop]");
		expect(body).not.toContain("USER: [script]");
	});

	it("tells it to ask first where no narration was read (#3980)", () => {
		stoppedSession();
		writeTranscript([]);
		handOff();
		const body = fs.readFileSync(commentFile(), "utf8");
		expect(parseHandOff(body)?.fields.Left).toContain(
			"so first ask by round anything this ticket leaves open for the founder",
		);
	});

	it("carries the same step where the diff is too long for a block (#3980)", () => {
		stoppedSession();
		fs.writeFileSync(path.join(sb.repo, "x.js"), "new\n".repeat(20_000));
		handOff();
		const body = fs.readFileSync(commentFile(), "utf8");
		expect(parseHandOff(body)).toBeNull();
		expect(body).toContain(
			"from the newest lines of the snapshot's narration, unless they end on a question",
		);
	});

	it("leaves the session's files as it left them", () => {
		stoppedSession();
		handOff();
		expect(fs.readFileSync(path.join(sb.repo, "x.js"), "utf8")).toBe("new\n");
		expect(fs.readFileSync(path.join(sb.repo, "y.js"), "utf8")).toBe("fresh\n");
	});

	describe("of a job with no record (#3988)", () => {
		const jobDir = () => path.join(plan(), "jobs", SHORT);

		it("warns the fresh session on each issue, carrying the session's diff and releasing its claim", () => {
			stoppedSession();
			fs.rmSync(jobDir(), { recursive: true });
			issueClaims.claimIssue(622, { sessionId: SID });
			const r = handOff(["--session", SID], [N, 622]);
			expect(r.stderr).toBe("");
			expect(r.status).toBe(0);
			expect(fs.readFileSync(commentedFile(), "utf8")).toBe(`${N}\n622\n`);
			const body = fs.readFileSync(commentFile(), "utf8");
			expect(handOffFaults(body)).toEqual([]);
			const h = parseHandOff(body);
			expect(h?.fields.Left).toContain(
				"so first ask by round anything this ticket leaves open for the founder",
			);
			expect(h?.fields["Blocked on"]).toContain(
				"it may have been waiting on the founder",
			);
			expect(body).toContain(`Session ${SID}`);
			expect(h && doneShas(h)).toEqual([]);
			expect(h?.uncommitted.sort()).toEqual(["x.js", "y.js"]);
			expect(issueClaims.readIssueClaims(N)).toEqual([]);
			expect(issueClaims.readIssueClaims(622)).toEqual([]);
		});

		it("still warns with no session id, promising no release", () => {
			stoppedSession();
			fs.rmSync(jobDir(), { recursive: true });
			const r = handOff();
			expect(r.stderr).toBe("");
			expect(r.status).toBe(0);
			const body = fs.readFileSync(commentFile(), "utf8");
			expect(handOffFaults(body)).toEqual([]);
			expect(parseHandOff(body)?.fields.Uncommitted).toBe("none");
			expect(body).not.toContain("released its claim");
			expect(issueClaims.readIssueClaims(N)).toHaveLength(1);
			expect(r.stdout).toContain(`left: any claim on #${N}`);
		});

		it("refuses a record that will not read, writing nothing, so a torn write is retried", () => {
			stoppedSession();
			fs.writeFileSync(path.join(jobDir(), "state.json"), "{ torn");
			const r = handOff(["--session", SID]);
			expect(r.status).toBe(2);
			expect(fs.existsSync(commentFile())).toBe(false);
			expect(issueClaims.readIssueClaims(N)).toHaveLength(1);
		});

		it("refuses a config dir with no job store", () => {
			stoppedSession();
			fs.rmSync(path.join(plan(), "jobs"), { recursive: true });
			const r = handOff(["--session", SID]);
			expect(r.status).toBe(2);
			expect(fs.existsSync(commentFile())).toBe(false);
		});
	});
});
