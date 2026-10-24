// @vitest-environment node
/*
 * record-issue-claim.sh records an issue claim in the session arbiter when a
 * session assigns itself to an issue (mantahostels#646, the build; mantahostels#645, which made the
 * arbiter the authority on which session claims which issue; mantahostels#633, which ruled
 * that a dead session's assignee must stop hiding an issue for good).
 *
 * It is a RECORDER, not a guard: no path may deny, emit a verdict, write to
 * stderr, or exit non-zero.
 *
 * The oracle is a stubbed `node` injected at WFC_NODE (§N7: each case chooses
 * its exit code), which writes the argv and the session id it was given to a
 * file. A stub says whether the arbiter was really
 * called; asserting on the hook's own output could not, since it has none.
 *
 * UNVERIFIED, and not counted as covered: the hook requires the subcommand to be
 * `edit`, and no other `gh issue` subcommand accepts `--add-assignee`, so no
 * command exists that would reach that half of the test. The `issue` half is
 * covered, by the `gh pr edit` case below.
 *
 * It runs as a PostToolUse hook on every `gh` call in `.claude/settings.json`:
 * loosen a case and a self-assigned issue goes unrecorded, so /pick-next keeps
 * it in everyone's shortlist and a second session takes it up.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
// The reader's own derivation of where a fail-open lands, not a copy of it —
// lib/guard-log.sh's header makes matching it byte for byte the invariant.
import { failOpenLogPath } from "./guard-log-fixture";
import { hookEnv, stubNode } from "./issue-claim-hook-fixture";

const HOOK = path.resolve(__dirname, "record-issue-claim.sh");
const ARBITER = path.resolve(__dirname, "session-arbiter.js");

let dir: string;
let config: string;
let project: string;
let calls: string;
let stub: string;

const run = (
	command: string,
	{
		sessionId = "sess-1",
		envSessionId = "",
		toolName = "Bash",
		node = stub,
		hook = HOOK,
	}: {
		sessionId?: string | null;
		/*
		 * CLAUDE_CODE_SESSION_ID, which a hook is handed per invocation and the
		 * recorder falls back to. Empty by default so the test run's own session id
		 * — inherited through process.env — cannot stand in for a payload that
		 * names none.
		 */
		envSessionId?: string;
		toolName?: string;
		node?: string | null;
		hook?: string;
	} = {},
) => {
	const payload: Record<string, unknown> = {
		tool_name: toolName,
		tool_input: { command },
	};
	if (sessionId !== null) payload.session_id = sessionId;
	const r = spawnSync(hook, [], {
		cwd: project,
		encoding: "utf8",
		input: JSON.stringify(payload),
		env: {
			// CLAUDE_CONFIG_DIR is set there: unset, a test run appends to the
			// founder's own fail-open log and manufactures the very records
			// check-guard-errors.js exists to report.
			...hookEnv(config, node),
			CLAUDE_CODE_SESSION_ID: envSessionId,
			CLAUDE_PROJECT_DIR: project,
		},
	});
	if (r.status === null) throw new Error(`hook did not run: ${r.error}`);
	// A recorder that denies, warns, or crashes is a defect whatever it recorded,
	// so every case asserts silence rather than only the ones about silence.
	expect(r.status).toBe(0);
	expect(r.stdout ?? "").toBe("");
	expect(r.stderr ?? "").toBe("");
	return r;
};

const callLines = () =>
	fs.existsSync(calls)
		? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean)
		: [];

/** The issue numbers the hook asked the arbiter to claim, in call order. */
const claimed = () =>
	callLines()
		.map((line) => /claim-issue\s+(\S+)/.exec(line)?.[1])
		.filter((n): n is string => Boolean(n));

/** The session ids the hook handed the arbiter, in call order. */
const sessions = () => callLines().map((line) => line.split("\t")[0]);

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "record-issue-claim-"));
	config = path.join(dir, "claude-config");
	project = path.join(dir, "project");
	calls = path.join(dir, "calls.log");
	stub = stubNode(dir, calls);
	fs.mkdirSync(project);
	// A URL-named issue counts only when it names the project's own origin, so
	// the project must be a repository that has one.
	execFileSync("git", ["init", "-q"], { cwd: project });
	execFileSync(
		"git",
		["remote", "add", "origin", "https://github.com/owner/repo.git"],
		{ cwd: project },
	);
});

describe("the assignments it records", () => {
	it("records a claim on gh issue edit <n> --add-assignee @me", () => {
		run("gh issue edit 646 --add-assignee @me");
		expect(claimed()).toEqual(["646"]);
	});

	it("hands the arbiter the payload's own session id", () => {
		run("gh issue edit 646 --add-assignee @me", { sessionId: "sess-xyz" });
		expect(sessions()).toEqual(["sess-xyz"]);
	});

	it("reads the --add-assignee=@me spelling", () => {
		run("gh issue edit 646 --add-assignee=@me");
		expect(claimed()).toEqual(["646"]);
	});

	it("reads a quoted @me", () => {
		run('gh issue edit 646 --add-assignee "@me"');
		expect(claimed()).toEqual(["646"]);
	});

	it("records every issue one call assigns", () => {
		run("gh issue edit 646 647 --add-assignee @me");
		expect(claimed()).toEqual(["646", "647"]);
	});

	it("reads an issue named by URL", () => {
		run(
			"gh issue edit https://github.com/owner/repo/issues/646 --add-assignee @me",
		);
		expect(claimed()).toEqual(["646"]);
	});

	it("reads an issue named as mantahostels#646", () => {
		run("gh issue edit '#646' --add-assignee @me");
		expect(claimed()).toEqual(["646"]);
	});

	it("records the assigning command only, out of several in one call", () => {
		run(
			"gh issue view 12 && gh issue edit 646 --add-assignee @me && gh issue edit 99 --add-label takes:implement",
		);
		expect(claimed()).toEqual(["646"]);
	});

	it("records an assignment made after other flags", () => {
		run("gh issue edit 646 --add-label takes:implement --add-assignee @me");
		expect(claimed()).toEqual(["646"]);
	});

	it("reads @me out of a comma-separated list of logins", () => {
		// The session is assigning itself whichever position it holds in the list.
		run("gh issue edit 646 --add-assignee owner,@me");
		expect(claimed()).toEqual(["646"]);
	});
});

describe("the commands it leaves alone", () => {
	const silent = (command: string) => {
		run(command);
		expect(claimed()).toEqual([]);
	};

	it("ignores an unassignment", () => {
		silent("gh issue edit 646 --remove-assignee @me");
	});

	it("ignores an assignment to somebody else", () => {
		silent("gh issue edit 646 --add-assignee owner");
	});

	it("ignores an assignment to Copilot", () => {
		silent("gh issue edit 646 --add-assignee @copilot");
	});

	it("ignores an edit that assigns nobody", () => {
		silent("gh issue edit 646 --add-label takes:implement");
	});

	it("ignores a @me sitting in another flag's value", () => {
		silent('gh issue edit 646 --title "@me"');
	});

	it("ignores a command that merely mentions the assignment", () => {
		silent(
			"grep -n 'gh issue edit 646 --add-assignee @me' docs/agents/issue-tracker.md",
		);
	});

	it("ignores an edit qualified with --repo, which may name another repo", () => {
		silent("gh issue edit 646 --add-assignee @me --repo someone/elsewhere");
	});

	it("ignores --repo even naming this repo, where record-acts.sh reads it (#2367)", () => {
		silent("gh issue edit 646 --add-assignee @me --repo owner/repo");
	});

	it("ignores a trailing --repo with no value left to take", () => {
		// gh would reject this command, but the hook records off the command and
		// never its result, so a --repo it read as absent would file the claim.
		silent("gh issue edit 646 --add-assignee @me --repo");
	});

	it("records nothing when the issue number is an unexpanded variable", () => {
		silent("gh issue edit $N --add-assignee @me");
	});

	it("ignores another gh subcommand", () => {
		silent("gh issue view 646 --json assignees");
	});

	it("ignores an assignment made on a pull request", () => {
		// GitHub shares one number space across issues and PRs, so a PR assignment
		// would otherwise be recorded as a claim on the issue of that number.
		silent("gh pr edit 646 --add-assignee @me");
	});

	it("claims the issue only, not a number given to another flag", () => {
		// Every one of these flags takes an issue number of its own, and each is a
		// number this session is not claiming. They stay out only because the
		// shared reader is told the whole value-taking set.
		run(
			"gh issue edit 646 --parent 640 --add-sub-issue 700 --add-blocked-by 701 --title 702 --add-assignee @me",
		);
		expect(claimed()).toEqual(["646"]);
	});

	it("ignores an issue URL belonging to another repository", () => {
		// A URL names its own repo, so it reaches past the --repo scoping: filing
		// this as a claim would hide a takeable local mantahostels#12 from /pick-next.
		silent(
			"gh issue edit https://github.com/someone/elsewhere/issues/12 --add-assignee @me",
		);
	});

	it("ignores a tool call that is not Bash", () => {
		run("gh issue edit 646 --add-assignee @me", { toolName: "Write" });
		expect(claimed()).toEqual([]);
	});
});

describe("the failures it swallows", () => {
	it("stays silent when the arbiter refuses", () => {
		run("gh issue edit 646 --add-assignee @me", {
			node: stubNode(dir, calls, 2),
		});
		// The call was still made — the refusal is the arbiter's, not a decision
		// taken here.
		expect(claimed()).toEqual(["646"]);
	});

	it("stays silent when the payload names no command", () => {
		const r = spawnSync(HOOK, [], {
			cwd: project,
			encoding: "utf8",
			input: JSON.stringify({ session_id: "s", tool_name: "Bash" }),
			env: hookEnv(config, stub),
		});
		expect(r.status).toBe(0);
		expect(r.stdout ?? "").toBe("");
		expect(r.stderr ?? "").toBe("");
		expect(claimed()).toEqual([]);
	});

	it("stays silent on a payload that is not JSON", () => {
		const r = spawnSync(HOOK, [], {
			cwd: project,
			encoding: "utf8",
			input: "not json",
			env: hookEnv(config, stub),
		});
		expect(r.status).toBe(0);
		expect(r.stdout ?? "").toBe("");
		expect(r.stderr ?? "").toBe("");
		expect(claimed()).toEqual([]);
	});

	it("records nothing when neither the payload nor the environment names a session", () => {
		run("gh issue edit 646 --add-assignee @me", { sessionId: null });
		expect(claimed()).toEqual([]);
	});

	it("falls back to the session id in the environment", () => {
		run("gh issue edit 646 --add-assignee @me", {
			sessionId: null,
			envSessionId: "sess-env",
		});
		expect(sessions()).toEqual(["sess-env"]);
	});

	it("records nothing, and leaves a fail-open line, when node is missing", () => {
		run("gh issue edit 646 --add-assignee @me", {
			node: path.join(dir, "no-such-node"),
		});
		expect(claimed()).toEqual([]);
		expect(fs.readFileSync(failOpenLogPath(config, project), "utf8")).toMatch(
			/record-issue-claim\.sh\tnode not found/,
		);
	});

	it("records nothing, and leaves a fail-open line, when the shared parser will not load", () => {
		// A detached copy so the real lib/ is never touched: the tests run in the
		// shared working tree, where a parallel session may be sourcing it.
		const at = path.join(dir, "detached");
		fs.mkdirSync(path.join(at, "lib"), { recursive: true });
		fs.copyFileSync(HOOK, path.join(at, "record-issue-claim.sh"));
		fs.chmodSync(path.join(at, "record-issue-claim.sh"), 0o755);
		// guard-log.sh reads the repo root through gr_root, which lives in
		// guard-root.sh since mantahostels#1905 — without it the fail-open record lands under
		// the wrong slug and this case tests nothing.
		for (const lib of ["guard-log.sh", "guard-root.sh"]) {
			fs.copyFileSync(
				path.resolve(__dirname, "lib", lib),
				path.join(at, "lib", lib),
			);
		}
		fs.writeFileSync(
			path.join(at, "lib/guard-parse.sh"),
			"this is not bash {\n",
		);

		run("gh issue edit 646 --add-assignee @me", {
			hook: path.join(at, "record-issue-claim.sh"),
		});
		expect(claimed()).toEqual([]);
		expect(fs.readFileSync(failOpenLogPath(config, project), "utf8")).toMatch(
			/record-issue-claim\.sh/,
		);
	});
});

describe("against the real arbiter", () => {
	it("records a claim the arbiter reads back under this session's id", () => {
		// No stub: the session id travels to the arbiter as an environment
		// variable, so only the arbiter itself can say it arrived.
		run("gh issue edit 646 --add-assignee @me", {
			sessionId: "sess-real",
			node: null,
		});
		const out = execFileSync(process.execPath, [ARBITER, "issue-claims"], {
			encoding: "utf8",
			env: {
				...process.env,
				CLAUDE_CONFIG_DIR: config,
				CLAUDE_PROJECT_DIR: project,
			},
		});
		expect(out).toMatch(/646/);
		expect(out).toMatch(/sess-real/);
	});
});
