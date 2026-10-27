// @vitest-environment node
/*
 * lib/issue-claim-hook.js, the cores of record-issue-claim.js and
 * release-issue-claim.js (#2799), in process: a session assigning itself with
 * `gh issue edit <n> --add-assignee @me` claims <n> in the arbiter
 * (mantahostels#646), and `gh issue close <n>` drops that claim
 * (mantahostels#706).
 *
 * The ports are the production ones, lib/gh-recorder-host.js's, over the
 * arbiter testkit's sandbox and a real git checkout whose origin names
 * owner/repo: no fake stands in for the claim store or for git.
 *
 * Loosen a claim case and a self-assigned issue goes unrecorded, so
 * /pick-next keeps it in everyone's shortlist and a second session takes it
 * up; loosen a release case and a claim outlives its issue, or another
 * repo's number drops a claim this session is still working.
 */

import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it } from "vitest";
import { freshSandbox, gitRepo, issueClaims } from "./arbiter-testkit";
import { kitContextFake } from "./kit-context-fake";

const { decideClaim, decideRelease } = require("./issue-claim-hook.js") as {
	decideClaim: (command: string, ctx: object) => null;
	decideRelease: (command: string, ctx: object) => null;
};
const { buildHostPorts } = require("./gh-recorder-host.js") as {
	buildHostPorts: (env: object) => Record<string, unknown>;
};

const sb = freshSandbox();

beforeEach(() => {
	gitRepo(sb);
	execFileSync(
		"git",
		["remote", "add", "origin", "https://github.com/owner/repo.git"],
		{ cwd: sb.repo },
	);
});

interface Call {
	sessionId?: string | null;
	envSession?: string;
	tool?: string;
}

function ctx({ sessionId = "sess-1", envSession = "", tool = "Bash" }: Call) {
	const payload: Record<string, unknown> = { tool_name: tool };
	if (sessionId !== null) payload.session_id = sessionId;
	const log = () => undefined;
	return kitContextFake({
		...buildHostPorts({ root: sb.repo, payload, log }),
		envSession,
		tool,
		cwd: sb.repo,
		fallbackCwd: sb.repo,
		isDir: () => true,
		log,
	});
}

/** Each claim on the store, as `<issue> <session>`, issue order. */
const claims = () =>
	(
		issueClaims.listIssueClaims().claims as {
			issue: number;
			sessionId: string;
		}[]
	)
		.map((c) => `${c.issue} ${c.sessionId}`)
		.sort();

const claim = (command: string, call: Call = {}) =>
	decideClaim(command, ctx(call));
const release = (command: string, call: Call = {}) =>
	decideRelease(command, ctx(call));

describe("the assignments it records", () => {
	it("records a claim on gh issue edit <n> --add-assignee @me, under the payload's session", () => {
		expect(claim("gh issue edit 646 --add-assignee @me")).toBeNull();
		expect(claims()).toEqual(["646 sess-1"]);
	});

	it.each([
		["--add-assignee=@me", "gh issue edit 646 --add-assignee=@me"],
		["a quoted @me", 'gh issue edit 646 --add-assignee "@me"'],
		["@me in a list of logins", "gh issue edit 646 --add-assignee owner,@me"],
		[
			"an assignment after other flags",
			"gh issue edit 646 --add-label takes:implement --add-assignee @me",
		],
		["a #-spelled number", "gh issue edit '#646' --add-assignee @me"],
		[
			"this repo's own issue URL",
			"gh issue edit https://github.com/owner/repo/issues/646 --add-assignee @me",
		],
	])("reads %s", (_, command) => {
		claim(command);
		expect(claims()).toEqual(["646 sess-1"]);
	});

	it("records every issue one call assigns", () => {
		claim("gh issue edit 646 647 --add-assignee @me");
		expect(claims()).toEqual(["646 sess-1", "647 sess-1"]);
	});

	it("records the assigning command only, out of several in one call", () => {
		claim(
			"gh issue view 12 && gh issue edit 646 --add-assignee @me && gh issue edit 99 --add-label takes:implement",
		);
		expect(claims()).toEqual(["646 sess-1"]);
	});

	it("claims the issue only, not a number given to another flag", () => {
		claim(
			"gh issue edit 646 --parent 640 --add-sub-issue 700 --add-blocked-by 701 --title 702 --add-assignee @me",
		);
		expect(claims()).toEqual(["646 sess-1"]);
	});

	it("falls back to the environment's session id", () => {
		claim("gh issue edit 646 --add-assignee @me", {
			sessionId: null,
			envSession: "sess-env",
		});
		expect(claims()).toEqual(["646 sess-env"]);
	});
});

describe("the edits it leaves alone", () => {
	it.each([
		["an unassignment", "gh issue edit 646 --remove-assignee @me"],
		[
			"an assignment to somebody else",
			"gh issue edit 646 --add-assignee owner",
		],
		["an assignment to Copilot", "gh issue edit 646 --add-assignee @copilot"],
		[
			"an edit assigning nobody",
			"gh issue edit 646 --add-label takes:implement",
		],
		["a @me in another flag's value", 'gh issue edit 646 --title "@me"'],
		[
			"a command merely mentioning it",
			"grep -n 'gh issue edit 646 --add-assignee @me' docs/agents/issue-tracker.md",
		],
		[
			"a --repo naming another repo",
			"gh issue edit 646 --add-assignee @me --repo someone/elsewhere",
		],
		[
			"a --repo naming this repo (#2367)",
			"gh issue edit 646 --add-assignee @me --repo owner/repo",
		],
		[
			"a trailing --repo with no value",
			"gh issue edit 646 --add-assignee @me --repo",
		],
		["an unexpanded variable", "gh issue edit $N --add-assignee @me"],
		["another gh subcommand", "gh issue view 646 --json assignees"],
		["a pull request", "gh pr edit 646 --add-assignee @me"],
		[
			"another repository's issue URL",
			"gh issue edit https://github.com/someone/elsewhere/issues/12 --add-assignee @me",
		],
	])("ignores %s", (_, command) => {
		claim(command);
		expect(claims()).toEqual([]);
	});

	it("ignores a tool call that is not Bash, and a call naming no session", () => {
		claim("gh issue edit 646 --add-assignee @me", { tool: "Write" });
		claim("gh issue edit 646 --add-assignee @me", { sessionId: null });
		expect(claims()).toEqual([]);
	});
});

describe("the closes it releases on", () => {
	beforeEach(() => {
		for (const n of [12, 706, 707, 999, 12_345])
			issueClaims.claimIssue(n, { sessionId: "sess-1" });
	});

	const kept = (...gone: number[]) =>
		["12", "706", "707", "999", "12345"]
			.filter((n) => !gone.map(String).includes(n))
			.map((n) => `${n} sess-1`)
			.sort();

	it.each([
		["a bare close", "gh issue close 706"],
		["a close carrying a comment", 'gh issue close 706 --comment "done"'],
		["a not-planned reason", 'gh issue close 706 --reason "not planned"'],
		[
			"this repo's issue URL",
			"gh issue close https://github.com/owner/repo/issues/706",
		],
		["a #-spelled number", "gh issue close '#706'"],
		[
			"the closing command of several",
			"gh issue view 12 && gh issue close 706",
		],
		[
			"the issue, not another flag's number",
			"gh issue close 706 -r 999 -c 12345",
		],
		[
			"the issue, not the one it duplicates",
			"gh issue close 706 --reason duplicate --duplicate-of 999",
		],
	])("releases on %s", (_, command) => {
		expect(release(command)).toBeNull();
		expect(claims()).toEqual(kept(706));
	});

	it("releases every issue one call closes", () => {
		release("gh issue close 706 707");
		expect(claims()).toEqual(kept(706, 707));
	});

	it("drops this session's claim only, the environment's where the payload names none", () => {
		issueClaims.claimIssue(706, { sessionId: "sess-other" });
		release("gh issue close 706", { sessionId: null, envSession: "sess-1" });
		expect(claims()).toEqual([...kept(706), "706 sess-other"].sort());
	});

	it.each([
		["another gh issue subcommand", "gh issue view 706 --json state"],
		["a reopen", "gh issue reopen 706"],
		["a pull request close", "gh pr close 706"],
		["a mention", "grep -n 'gh issue close 706' docs/agents/issue-tracker.md"],
		[
			"a --repo naming another repo",
			"gh issue close 706 --repo someone/elsewhere",
		],
		[
			"a --repo naming this repo (#2367)",
			"gh issue close 706 --repo owner/repo",
		],
		["a trailing --repo", "gh issue close 706 --repo"],
		["an unexpanded variable", "gh issue close $N"],
		[
			"another repository's URL",
			"gh issue close https://github.com/someone/elsewhere/issues/12",
		],
		[
			"a pull-request URL",
			"gh issue close https://github.com/owner/repo/pull/706",
		],
		["a close naming no issue", "gh issue close"],
	])("ignores %s", (_, command) => {
		release(command);
		expect(claims()).toEqual(kept());
	});

	it("ignores a tool call that is not Bash", () => {
		release("gh issue close 706", { tool: "Write" });
		expect(claims()).toEqual(kept());
	});
});
