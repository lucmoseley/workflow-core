// @vitest-environment node
/*
 * record-acts.sh writes a session's raw `gh` close, question round, `takes:`
 * relabel and blocked-by edge to its acts ledger, one line per act (#2308,
 * #2464, spec #2245).
 *
 * Driven end to end: the hook, the real session-arbiter.js record-act, and the
 * ledger read back through actsBy, in arbiter-testkit's sandbox with the repo a
 * git checkout whose origin names owner/repo.
 *
 * The refill loop judges a launch's progress from these lines: a case loosened
 * here lets a launch that did nothing read as progress, or one that asked a
 * round read as idle and count toward the loop's no-progress stop.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { freshSandbox, gitRepo, store } from "./lib/arbiter-testkit";

const HOOK = path.resolve(__dirname, "record-acts.sh");
const SID = "sess-acts";
const ROUND =
	"Some context.\n\n❓ **Q1** Which way?\n(A) This\nConfidence: 70% (60% - 80%). why\n";

const sb = freshSandbox();

beforeEach(() => {
	gitRepo(sb);
	execFileSync(
		"git",
		["remote", "add", "origin", "https://github.com/owner/repo.git"],
		{ cwd: sb.repo },
	);
});

const run = (command: string, sessionId: string | null = SID, stderr = "") => {
	const payload: Record<string, unknown> = {
		tool_name: "Bash",
		tool_input: { command },
		tool_response: { stdout: "", stderr },
		cwd: sb.repo,
	};
	if (sessionId !== null) payload.session_id = sessionId;
	const r = spawnSync(HOOK, [], {
		cwd: sb.repo,
		encoding: "utf8",
		input: JSON.stringify(payload),
		env: {
			...process.env,
			CLAUDE_CONFIG_DIR: sb.home,
			CLAUDE_CODE_SESSION_ID: "",
		},
	});
	if (r.status === null) throw new Error(`hook did not run: ${r.error}`);
	// A recorder that speaks or fails is a defect whatever it recorded.
	expect(r.status).toBe(0);
	expect(r.stdout).toBe("");
	expect(r.stderr).toBe("");
};

const acts = (sessionId = SID) => store.actsBy(sessionId, [sb.repo]).acts;

describe("close", () => {
	it("records one close line on gh issue close <n>", () => {
		run("gh issue close 12 --reason completed");
		expect(acts()).toEqual(["close owner/repo#12"]);
	});

	it("names the --repo a close names, and an issue URL's own repo", () => {
		run("gh issue close 3 --repo other/thing");
		run("gh issue close https://github.com/far/away/issues/9");
		expect(acts()).toEqual(["close other/thing#3", "close far/away#9"]);
	});

	it("takes no repo from a URL whose number is no issue number (#2367)", () => {
		run("gh issue close 5 https://github.com/far/away/issues/1234567890");
		expect(acts()).toEqual(["close owner/repo#5"]);
	});

	it("records nothing for a close gh reports as already closed", () => {
		run(
			"gh issue close 12",
			SID,
			"! Issue owner/repo#12 (Some title) is already closed\n",
		);
		expect(acts()).toEqual([]);
	});

	it("never reads a --duplicate-of value as a second issue closed", () => {
		run("gh issue close 5 --reason duplicate --duplicate-of 3");
		expect(acts()).toEqual(["close owner/repo#5"]);
	});

	it("records nothing for a pr close, or with no session id", () => {
		run("gh pr close 12");
		run("gh issue close 13", null);
		expect(acts()).toEqual([]);
	});
});

describe("round — every comment spelling the hook can see", () => {
	it("reads an inline --body", () => {
		run(`gh issue comment 5 --body '${ROUND}'`);
		expect(acts()).toEqual(["round owner/repo#5"]);
	});

	it("reads a --body-file path", () => {
		fs.writeFileSync(path.join(sb.repo, "c.md"), ROUND);
		run("gh issue comment 5 --body-file c.md");
		expect(acts()).toEqual(["round owner/repo#5"]);
	});

	it("reads stdin from a single-quoted heredoc", () => {
		run(`gh issue comment 5 --body-file - <<'EOF'\n${ROUND}EOF`);
		expect(acts()).toEqual(["round owner/repo#5"]);
	});

	it("reads stdin from a cat of a file", () => {
		fs.writeFileSync(path.join(sb.repo, "c.md"), ROUND);
		run("cat c.md | gh issue comment 5 --body-file -");
		expect(acts()).toEqual(["round owner/repo#5"]);
	});

	it("records nothing for a comment that opens no round", () => {
		run(`gh issue comment 5 --body 'Done: Q1 answered (A).'`);
		expect(acts()).toEqual([]);
	});

	it("records nothing where the body cannot be read, or no new comment is posted", () => {
		run(`gh issue comment 5 --body "$(cat c.md)"`);
		run(`gh issue comment 5 --edit-last --body '${ROUND}'`);
		run("gh issue comment 5 --body-file missing.md");
		expect(acts()).toEqual([]);
	});
});

describe("relabel", () => {
	it("records each takes: label added, per issue", () => {
		run(
			"gh issue edit 7 8 --add-label takes:implement,kind:ticket --remove-label takes:triage",
		);
		expect(acts()).toEqual([
			"relabel owner/repo#7 takes:implement",
			"relabel owner/repo#8 takes:implement",
		]);
	});

	it("never reads a --parent value as an issue relabelled", () => {
		run("gh issue edit 7 --add-label takes:implement --parent 2245");
		expect(acts()).toEqual(["relabel owner/repo#7 takes:implement"]);
	});

	it("records nothing for a removal alone or a label that is not takes:", () => {
		run("gh issue edit 7 --remove-label takes:triage");
		run("gh issue edit 7 --add-label urgent");
		expect(acts()).toEqual([]);
	});
});

describe("block", () => {
	it("records a gh api POST to an issue's blocked_by, in each method spelling", () => {
		run(
			"gh api repos/far/away/issues/2347/dependencies/blocked_by -X POST -F issue_id=99",
		);
		run(
			"gh api --method POST /repos/far/away/issues/2348/dependencies/blocked_by -F issue_id=99",
		);
		run(
			"gh api repos/{owner}/{repo}/issues/2349/dependencies/blocked_by -F issue_id=99",
		);
		expect(acts()).toEqual([
			"block far/away#2347",
			"block far/away#2348",
			"block owner/repo#2349",
		]);
	});

	it("records a gh issue edit --add-blocked-by, per issue", () => {
		run("gh issue edit 7 8 --add-blocked-by 200");
		expect(acts()).toEqual(["block owner/repo#7", "block owner/repo#8"]);
	});

	it("records nothing for a read, a removal or a half-placeholder repo", () => {
		run("gh api repos/far/away/issues/5/dependencies/blocked_by");
		run("gh api -X DELETE repos/far/away/issues/5/dependencies/blocked_by/99");
		run(
			"gh api repos/{owner}/away/issues/5/dependencies/blocked_by -F issue_id=99",
		);
		run("gh api repos/far/away/issues/5/comments -f body=hi");
		run("gh issue edit 5 --remove-blocked-by 200");
		expect(acts()).toEqual([]);
	});
});
