// @vitest-environment node
/*
 * lib/rescue-takeover.js's hand-off, the core behind `rescue-sessions.js
 * hand-off`, the refill loop's takeover of a resumed-idle session it stopped
 * (#2659), in-process on lib/rescue-ports-fake.ts's `gh` (#5157), in a
 * sandbox holding a real git repo and arbiter store.
 * rescue-sessions-hand-off.test.ts keeps one hand-off through the program.
 *
 * Breaking it costs the fresh session its pick-up: a comment read-hand-off.js
 * passes over, a diff carrying a neighbour's file, a known session's claim left
 * standing, or the stopped session's files restored out from under it. Of a job
 * whose record is gone (#3988), it costs the warning that the old session may
 * have been waiting on the founder.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	commitAll,
	freshSandbox,
	gitRepo,
	issueClaims,
	ledger,
} from "./arbiter-testkit";
import { doneShas, handOffFaults, parseHandOff } from "./hand-off.js";
import { BOOT_PROMPT, scriptPrompt } from "./loop-prompts.js";
import { rescueCoreKit } from "./rescue-core-kit";
import { SHORT, SID, said, withTracker } from "./rescue-testkit";

const N = 621;
const sb = freshSandbox(withTracker);
const { plan, writeTranscript, jobState, world, run } = rescueCoreKit(sb);

/** `hand-off` for #621 on the sandbox plan. */
const handOff = (extra: string[] = [], issues = [N]) =>
	run("hand-off", [
		"--from",
		plan(),
		"--job",
		SHORT,
		...extra,
		...issues.flatMap((n) => ["--issue", `${n}`]),
	]);

const comments = () =>
	world().ghCalls.filter(
		({ args }) => `${args[0]} ${args[1]}` === "issue comment",
	);
/** The last comment's body. */
const posted = () => comments().at(-1)?.input ?? "";
const commented = () => comments().length > 0;
/** Each issue commented on, a line each. */
const commentedOn = () =>
	comments()
		.map(({ args }) => `${args[2]}\n`)
		.join("");

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
	it("tells the fresh session to build nothing past a question the narration ends on, reading past the loop's own prompts (#3980)", async () => {
		stoppedSession();
		writeTranscript([
			said("Shall we ship it?"),
			JSON.stringify({ type: "user", message: { content: BOOT_PROMPT } }),
			JSON.stringify({
				type: "user",
				message: { content: scriptPrompt("carry on") },
			}),
		]);
		await handOff();
		const body = posted();
		expect(parseHandOff(body)?.fields.Left).toContain(
			"unless they end on a question to the founder that this ticket does not show answered",
		);
		expect(body).toContain("A: Shall we ship it?");
		expect(body).not.toContain("USER: [refill loop]");
		expect(body).not.toContain(scriptPrompt("carry on"));
	});

	it("tells it to ask first where no narration was read (#3980)", async () => {
		stoppedSession();
		writeTranscript([]);
		await handOff();
		const body = posted();
		expect(parseHandOff(body)?.fields.Left).toContain(
			"so first ask by round anything this ticket leaves open for the founder",
		);
	});

	it("carries the same step where the diff is too long for a block (#3980)", async () => {
		stoppedSession();
		fs.writeFileSync(path.join(sb.repo, "x.js"), "new\n".repeat(20_000));
		await handOff();
		const body = posted();
		expect(parseHandOff(body)).toBeNull();
		expect(body).toContain(
			"from the newest lines of the snapshot's narration, unless they end on a question",
		);
	});

	it("leaves the session's files as it left them", async () => {
		stoppedSession();
		await handOff();
		expect(fs.readFileSync(path.join(sb.repo, "x.js"), "utf8")).toBe("new\n");
		expect(fs.readFileSync(path.join(sb.repo, "y.js"), "utf8")).toBe("fresh\n");
	});

	describe("of a job with no record (#3988)", () => {
		const jobDir = () => path.join(plan(), "jobs", SHORT);

		it("warns the fresh session on each issue, carrying the session's diff and releasing its claim", async () => {
			stoppedSession();
			fs.rmSync(jobDir(), { recursive: true });
			issueClaims.claimIssue(622, { sessionId: SID });
			const r = await handOff(["--session", SID], [N, 622]);
			expect(r.stderr).toBe("");
			expect(r.status).toBe(0);
			expect(commentedOn()).toBe(`${N}\n622\n`);
			const body = posted();
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

		it("still warns with no session id, promising no release", async () => {
			stoppedSession();
			fs.rmSync(jobDir(), { recursive: true });
			const r = await handOff();
			expect(r.stderr).toBe("");
			expect(r.status).toBe(0);
			const body = posted();
			expect(handOffFaults(body)).toEqual([]);
			expect(parseHandOff(body)?.fields.Uncommitted).toBe("none");
			expect(body).not.toContain("released its claim");
			expect(issueClaims.readIssueClaims(N)).toHaveLength(1);
			expect(r.stdout).toContain(`left: any claim on #${N}`);
		});

		it("refuses a record that will not read, writing nothing, so a torn write is retried", async () => {
			stoppedSession();
			fs.writeFileSync(path.join(jobDir(), "state.json"), "{ torn");
			const r = await handOff(["--session", SID]);
			expect(r.status).toBe(2);
			expect(commented()).toBe(false);
			expect(issueClaims.readIssueClaims(N)).toHaveLength(1);
		});

		it("refuses a config dir with no job store", async () => {
			stoppedSession();
			fs.rmSync(path.join(plan(), "jobs"), { recursive: true });
			const r = await handOff(["--session", SID]);
			expect(r.status).toBe(2);
			expect(commented()).toBe(false);
		});
	});
});
