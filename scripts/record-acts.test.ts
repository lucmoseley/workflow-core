// @vitest-environment node
/*
 * record-acts.js writes a session's raw `gh` close, question round, `takes:`
 * relabel and blocked-by edge to its acts ledger, one line per act (#2308,
 * #2464, spec #2245). These are its boundary cases: the line hooks/hooks.json
 * registers, run by bash as the harness runs it, on a harness-shaped payload —
 * the wiring, the session id's two channels, the fail-open record, and the
 * ledger, the fs and git crossed for real. Which call records which act is
 * lib/gh-acts.test.ts's (#2799).
 *
 * Break the line and the refill loop reads every launch as idle.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { readFailOpenLog } from "./guard-log-fixture";
import { freshSandbox, gitRepo, store } from "./lib/arbiter-testkit";
import {
	buildBashPayload,
	guardOutput,
	readHookLines,
} from "./lib/pretool-guard-testkit";

const SCRIPT = "scripts/record-acts.js";
const LINES = readHookLines("hooks/hooks.json", SCRIPT);
const CHECKOUT = path.resolve(__dirname, "..");
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

const fire = (
	command: string,
	{
		session = "s1" as string | null,
		stderr = "",
		stdin,
		env = {},
	}: {
		session?: string | null;
		stderr?: string;
		stdin?: string;
		env?: NodeJS.ProcessEnv;
	} = {},
) =>
	guardOutput(
		"/bin/bash",
		{
			...buildBashPayload(command, session),
			hook_event_name: "PostToolUse",
			tool_response: { stdout: "", stderr },
		},
		{
			project: sb.repo,
			config: sb.home,
			cwd: sb.repo,
			args: ["-c", LINES[0] ?? ""],
			stdin,
			env: { CLAUDE_PLUGIN_ROOT: CHECKOUT, ...env },
		},
	);

const readActs = (session = "s1") => store.readActsBy(session, [sb.repo]).acts;
const readFaults = () => readFailOpenLog(sb.home, sb.repo);

describe("the registered hook line", () => {
	it("is one line, narrowed by `if: Bash(gh *)`, in the plugin and the self-plugin alike", () => {
		for (const file of ["hooks/hooks.json", "self-plugin/hooks/hooks.json"]) {
			const entries = Object.values(
				JSON.parse(fs.readFileSync(path.join(CHECKOUT, file), "utf8"))
					.hooks as Record<string, { hooks: Record<string, unknown>[] }[]>,
			)
				.flat()
				.flatMap((group) => group.hooks)
				.filter((hook) => String(hook.command).includes(SCRIPT));
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({ if: "Bash(gh *)" });
			expect(entries[0]).not.toHaveProperty("args");
		}
	});
});

describe("each exit", () => {
	it("writes the close to the payload's session's ledger, naming the origin's repo, silent on exit 0", () => {
		expect(fire("gh issue close 12")).toBeNull();
		expect(readActs()).toEqual(["close owner/repo#12"]);
		expect(readFaults()).toBe("");
	});

	it("falls back to CLAUDE_CODE_SESSION_ID where the payload names no session", () => {
		fire("gh issue close 12", {
			session: null,
			env: { CLAUDE_CODE_SESSION_ID: "sess-env" },
		});
		expect(readActs("sess-env")).toEqual(["close owner/repo#12"]);
	});

	it("reads gh's already-closed line from the call's own output", () => {
		fire("gh issue close 12", {
			stderr: "! Issue owner/repo#12 (Some title) is already closed\n",
		});
		expect(readActs()).toEqual([]);
	});

	it("reads a round from a --body-file on disk", () => {
		fs.writeFileSync(path.join(sb.repo, "c.md"), ROUND);
		fire("gh issue comment 5 --body-file c.md");
		expect(readActs()).toEqual(["round owner/repo#5"]);
	});
});

describe("what it fails open on", () => {
	it("is silent on a payload carrying no command, and records that it did", () => {
		expect(
			fire("", {
				stdin: JSON.stringify({ session_id: "s1", tool_name: "Bash" }),
			}),
		).toBeNull();
		expect(readFaults()).toMatch(/record-acts\.js\t.*no command in payload/);
	});

	it("records nothing on a payload that is not JSON, and records that it did", () => {
		expect(fire("", { stdin: "not json" })).toBeNull();
		expect(readFaults()).toMatch(
			/record-acts\.js\t.*payload did not parse as JSON/,
		);
	});

	it("records nothing, exit 0 and silent, where node is not on PATH", () => {
		expect(
			fire("gh issue close 12", { env: { PATH: "/nonexistent" } }),
		).toBeNull();
		expect(readActs()).toEqual([]);
	});
});
