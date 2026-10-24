// @vitest-environment node
/*
 * guard-blind-dispatch.sh refuses an Agent dispatch saying "blind" until its
 * prompt names the HEAD whose snapshot the dispatcher read (#1783).
 *
 * Loosen it and a blind scorer reads its answer off a commit subject; tighten
 * it and every dispatch mentioning the word is refused with no way through.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeFailOpenLog } from "./guard-log-fixture";

const GUARD = path.resolve(__dirname, "guard-blind-dispatch.sh");

let dir: string;
let config: string;
let project: string;

const git = (...args: string[]) => {
	const r = spawnSync(
		"git",
		["-C", project, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
		{ encoding: "utf8" },
	);
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
};

const commit = (subject: string) => {
	git("commit", "-q", "--allow-empty", "-m", subject);
	return git("rev-parse", "--short", "HEAD");
};

const run = (
	input: Record<string, unknown>,
	{
		env = {},
		cwd = project,
		tool = "Agent",
	}: { env?: Record<string, string>; cwd?: string; tool?: string } = {},
) => {
	const base = { ...process.env };
	delete base.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS;
	const r = spawnSync(GUARD, [], {
		encoding: "utf8",
		input: JSON.stringify({
			session_id: "s1",
			tool_name: tool,
			cwd,
			tool_input: {
				description: "score photos",
				subagent_type: "general-purpose",
				...input,
			},
		}),
		env: {
			...base,
			CLAUDE_CONFIG_DIR: config,
			CLAUDE_PROJECT_DIR: project,
			...env,
		},
	});
	if (r.status === null) throw new Error(`guard did not run: ${r.error}`);
	return r;
};

const reasonOf = (r: ReturnType<typeof run>): string => {
	expect(r.status).toBe(0);
	const out = JSON.parse(r.stdout);
	expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
	return out.hookSpecificOutput.permissionDecisionReason;
};

const expectSilentAllow = (r: ReturnType<typeof run>) => {
	expect(r.status).toBe(0);
	expect(r.stdout ?? "").toBe("");
	expect(r.stderr ?? "").toBe("");
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-blind-dispatch-"));
	config = path.join(dir, "claude-config");
	project = path.join(dir, "project");
	fs.mkdirSync(project);
	git("init", "-q", "-b", "trunk");
	commit("Set C005 to a score of 1");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("an unchecked blind dispatch is refused with its snapshot", () => {
	it("prints the branch, the subjects, the status and the line to add", () => {
		fs.writeFileSync(path.join(project, "c009-expected.txt"), "2");
		const head = git("rev-parse", "--short", "HEAD");
		const reason = reasonOf(run({ prompt: "Score photo C005 blind." }));
		expect(reason).toContain("Branch: trunk");
		expect(reason).toContain("Set C005 to a score of 1");
		expect(reason).toContain("?? c009-expected.txt");
		expect(reason).toContain(`Blind-checked: ${head}`);
		expect(reason).toContain("blind-dispatch.md");
	});

	it("reads the description as well as the prompt", () => {
		reasonOf(run({ prompt: "Score photo C005.", description: "blind scorer" }));
	});

	it("caps a long status at twenty lines and counts the rest", () => {
		for (let i = 0; i < 23; i++)
			fs.writeFileSync(path.join(project, `f${i}.txt`), "");
		const reason = reasonOf(run({ prompt: "blind run" }));
		expect(reason).toContain("… and 3 more");
	});

	it("says so when the line names no commit here", () => {
		const reason = reasonOf(
			run({ prompt: "blind run\nBlind-checked: deadbeef1" }),
		);
		expect(reason).toContain("names no commit in this repository");
		expect(reason).toContain("Recent commits:");
	});
});

describe("a check is good for the HEAD it names", () => {
	it("passes a line naming the current HEAD, short or full", () => {
		const short = git("rev-parse", "--short", "HEAD");
		const full = git("rev-parse", "HEAD");
		expectSilentAllow(run({ prompt: `blind run\nBlind-checked: ${short}` }));
		expectSilentAllow(run({ prompt: `blind run\n  Blind-checked: ${full}` }));
	});

	it("refuses a line HEAD has moved past, naming what landed since", () => {
		const old = git("rev-parse", "--short", "HEAD");
		const now = commit("Move C009's line to 2 or more");
		const reason = reasonOf(
			run({ prompt: `blind run\nBlind-checked: ${old}` }),
		);
		expect(reason).toContain("is no longer HEAD");
		expect(reason).toContain("Move C009's line to 2 or more");
		expect(reason).not.toContain("Set C005 to a score of 1");
		expect(reason).toContain(`Blind-checked: ${now}`);
	});
});

describe("dispatches with no snapshot to leak pass", () => {
	it.each(["Explore", "Plan"])("passes %s, which starts with none", (type) => {
		expectSilentAllow(run({ prompt: "blind run", subagent_type: type }));
	});

	it.each(["1", "true", "ON"])(
		"passes the recipe's child, CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=%s",
		(value) => {
			expectSilentAllow(
				run(
					{ prompt: "blind run" },
					{ env: { CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: value } },
				),
			);
		},
	);

	it("passes a cwd outside any repository", () => {
		const outside = path.join(dir, "outside");
		fs.mkdirSync(outside);
		expectSilentAllow(run({ prompt: "blind run" }, { cwd: outside }));
	});
});

describe("a fork is never blind", () => {
	it("is refused even with a current check", () => {
		const head = git("rev-parse", "--short", "HEAD");
		const reason = reasonOf(
			run({
				prompt: `blind run\nBlind-checked: ${head}`,
				subagent_type: "fork",
			}),
		);
		expect(reason).toContain("never blind");
	});
});

describe("dispatches that are not blind pass", () => {
	it.each([
		"Review this diff for bugs.",
		"Look for blind spots in the guard.",
		"Name the blind-spot it misses.",
		"Its blindspots are listed.",
	])("passes the prompt %s", (prompt) => {
		expectSilentAllow(run({ prompt }));
	});

	it("passes another tool's blind input, should the matcher widen", () => {
		expectSilentAllow(run({ prompt: "blind run" }, { tool: "Skill" }));
	});
});

describeFailOpenLog({
	guard: GUARD,
	denied: { tool_name: "Agent", tool_input: { prompt: "blind run" } },
	fieldless: { tool_name: "Agent", tool_input: {} },
	fieldlessMatch: /no prompt in payload/,
	benign: { tool_name: "Agent", tool_input: { prompt: "Review this diff." } },
	ctx: () => ({
		dir,
		config,
		project,
		env: { CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "0" },
	}),
});
