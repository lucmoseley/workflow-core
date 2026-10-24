// @vitest-environment node
/*
 * release-issue-claim.sh drops this session's arbiter claim on an issue when the
 * session closes it (mantahostels#706, the build; mantahostels#645, which made the arbiter the authority
 * on which session claims which issue; mantahostels#646, the recorder it pairs with).
 *
 * It is a RELEASER, not a guard: no path may deny, emit a verdict, write to
 * stderr, or exit non-zero.
 *
 * The oracle is a stubbed `node` injected at WFC_NODE (§N7: each case chooses
 * its exit code), which writes the argv and the session id it was given to a
 * file. A stub says whether the arbiter was really
 * called; asserting on the hook's own output could not, since it has none.
 *
 * It runs as a PostToolUse hook on every `gh` call in `.claude/settings.json`:
 * loosen a case and `session-arbiter.js issue-claims` lists closed issues as
 * still being worked, or the hook drops a claim on an issue it never closed.
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

const HOOK = path.resolve(__dirname, "release-issue-claim.sh");
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
		 * releaser falls back to. Empty by default so the test run's own session id
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
	// A releaser that denies, warns, or crashes is a defect whatever it released,
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

/** The issue numbers the hook asked the arbiter to release, in call order. */
const released = () =>
	callLines()
		.map((line) => /release-issue\s+(\S+)/.exec(line)?.[1])
		.filter((n): n is string => Boolean(n));

/** The session ids the hook handed the arbiter, in call order. */
const sessions = () => callLines().map((line) => line.split("\t")[0]);

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-issue-claim-"));
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

describe("the closes it releases on", () => {
	it("releases the claim on gh issue close <n>", () => {
		run("gh issue close 706");
		expect(released()).toEqual(["706"]);
	});

	it("hands the arbiter the payload's own session id", () => {
		run("gh issue close 706", { sessionId: "sess-xyz" });
		expect(sessions()).toEqual(["sess-xyz"]);
	});

	it("releases a close carrying a comment", () => {
		run(`gh issue close 706 --comment "done"`);
		expect(released()).toEqual(["706"]);
	});

	it("releases a close carrying a not-planned reason", () => {
		// The reason changes nothing here: an abandoned issue is no longer being
		// worked either.
		run(`gh issue close 706 --reason "not planned"`);
		expect(released()).toEqual(["706"]);
	});

	it("releases every issue one call closes", () => {
		run("gh issue close 706 707");
		expect(released()).toEqual(["706", "707"]);
	});

	it("reads an issue named by URL", () => {
		run("gh issue close https://github.com/owner/repo/issues/706");
		expect(released()).toEqual(["706"]);
	});

	it("reads an issue named as mantahostels#706", () => {
		run("gh issue close '#706'");
		expect(released()).toEqual(["706"]);
	});

	it("releases the closing command only, out of several in one call", () => {
		run(
			"gh issue view 12 && gh issue close 706 && gh issue edit 99 --add-label takes:implement",
		);
		expect(released()).toEqual(["706"]);
	});
});

describe("the commands it leaves alone", () => {
	const silent = (command: string) => {
		run(command);
		expect(released()).toEqual([]);
	};

	it("ignores another gh issue subcommand", () => {
		silent("gh issue view 706 --json state");
	});

	it("ignores reopening an issue", () => {
		silent("gh issue reopen 706");
	});

	it("ignores a close made on a pull request", () => {
		// GitHub shares one number space across issues and PRs, so a PR close would
		// otherwise drop the claim on the issue of that number.
		silent("gh pr close 706");
	});

	it("ignores a command that merely mentions the close", () => {
		silent("grep -n 'gh issue close 706' docs/agents/issue-tracker.md");
	});

	it("ignores a close qualified with --repo, which may name another repo", () => {
		silent("gh issue close 706 --repo someone/elsewhere");
	});

	it("ignores --repo even naming this repo, where record-acts.sh reads it (#2367)", () => {
		silent("gh issue close 706 --repo owner/repo");
	});

	it("ignores a trailing --repo with no value left to take", () => {
		// gh would reject this command, but the hook releases off the command and
		// never its result, so a --repo it read as absent would drop the claim.
		silent("gh issue close 706 --repo");
	});

	it("releases nothing when the issue number is an unexpanded variable", () => {
		silent("gh issue close $N");
	});

	it("releases the issue only, not a number given to another flag", () => {
		// -r and -c both take a value, and a bare number is a legal one. They stay
		// out only because the shared reader is told the whole value-taking set.
		run("gh issue close 706 -r 999 -c 12345");
		expect(released()).toEqual(["706"]);
	});

	it("ignores an issue URL belonging to another repository", () => {
		// A URL names its own repo, so it reaches past the --repo scoping: acting on
		// this would drop the claim on a local mantahostels#12 this session may still be working.
		silent("gh issue close https://github.com/someone/elsewhere/issues/12");
	});

	it("ignores a bare word that is no issue number at all", () => {
		// gh takes a URL as well as a number, and a pull-request URL is neither an
		// issue nor a number: pushed through as a claim it would hand the arbiter a
		// whole URL to file.
		silent("gh issue close https://github.com/owner/repo/pull/706");
	});

	it("releases nothing on a close naming no issue at all", () => {
		silent("gh issue close");
	});

	it("ignores a tool call that is not Bash", () => {
		run("gh issue close 706", { toolName: "Write" });
		expect(released()).toEqual([]);
	});
});

describe("the failures it swallows", () => {
	it("stays silent when the arbiter refuses", () => {
		run("gh issue close 706", { node: stubNode(dir, calls, 1) });
		// The call was still made — the refusal is the arbiter's, not a decision
		// taken here, and it leaves the claim standing rather than half-dropped.
		expect(released()).toEqual(["706"]);
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
		expect(released()).toEqual([]);
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
		expect(released()).toEqual([]);
	});

	it("releases nothing when neither the payload nor the environment names a session", () => {
		run("gh issue close 706", { sessionId: null });
		expect(released()).toEqual([]);
	});

	it("falls back to the session id in the environment", () => {
		run("gh issue close 706", { sessionId: null, envSessionId: "sess-env" });
		expect(sessions()).toEqual(["sess-env"]);
	});

	it("releases nothing, and leaves a fail-open line, when node is missing", () => {
		run("gh issue close 706", { node: path.join(dir, "no-such-node") });
		expect(released()).toEqual([]);
		expect(fs.readFileSync(failOpenLogPath(config, project), "utf8")).toMatch(
			/release-issue-claim\.sh\tnode not found/,
		);
	});

	it("releases nothing, and leaves a fail-open line, when the shared parser will not load", () => {
		// A detached copy so the real lib/ is never touched: the tests run in the
		// shared working tree, where a parallel session may be sourcing it.
		const at = path.join(dir, "detached");
		fs.mkdirSync(path.join(at, "lib"), { recursive: true });
		fs.copyFileSync(HOOK, path.join(at, "release-issue-claim.sh"));
		fs.chmodSync(path.join(at, "release-issue-claim.sh"), 0o755);
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

		run("gh issue close 706", {
			hook: path.join(at, "release-issue-claim.sh"),
		});
		expect(released()).toEqual([]);
		expect(fs.readFileSync(failOpenLogPath(config, project), "utf8")).toMatch(
			/release-issue-claim\.sh/,
		);
	});
});

describe("against the real arbiter", () => {
	const arbiter = (...argv: string[]) =>
		execFileSync(process.execPath, [ARBITER, ...argv], {
			encoding: "utf8",
			env: {
				...process.env,
				CLAUDE_CONFIG_DIR: config,
				CLAUDE_PROJECT_DIR: project,
				CLAUDE_CODE_SESSION_ID: "sess-real",
			},
		});

	it("drops a claim the arbiter had recorded under this session's id", () => {
		// No stub: the session id travels to the arbiter as an environment
		// variable, so only the arbiter itself can say it arrived.
		arbiter("claim-issue", "706");
		expect(arbiter("issue-claims")).toMatch(/706/);

		run("gh issue close 706", {
			sessionId: "sess-real",
			node: null,
		});
		expect(arbiter("issue-claims")).not.toMatch(/706/);
	});

	it("leaves another session's claim standing", () => {
		// The arbiter refuses to take a session id from argv, so a close made by a
		// session that never claimed the issue drops nothing (mantahostels#411's reasoning,
		// applied to issue claims).
		execFileSync(process.execPath, [ARBITER, "claim-issue", "706"], {
			encoding: "utf8",
			env: {
				...process.env,
				CLAUDE_CONFIG_DIR: config,
				CLAUDE_PROJECT_DIR: project,
				CLAUDE_CODE_SESSION_ID: "sess-other",
			},
		});

		run("gh issue close 706", {
			sessionId: "sess-real",
			node: null,
		});
		expect(arbiter("issue-claims")).toMatch(/706\s+sess-other/);
	});
});
