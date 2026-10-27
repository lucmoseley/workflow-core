// @vitest-environment node
/*
 * lib/blind-dispatch.js, a PreToolUse dispatcher core (#2791), refuses an
 * Agent dispatch saying "blind" until its prompt names the HEAD whose snapshot
 * the dispatcher read (#1783).
 *
 * Module cases, run in process through lib/guard-core-testkit.ts over the
 * production git adapter, in a temp repository.
 *
 * Loosen it and a blind scorer reads its answer off a commit subject; tighten
 * it and every dispatch mentioning the word is refused with no way through.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCore } from "./guard-core-testkit";

let dir: string;
let project: string;
let logs: string[];

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
		cwd = project as string | undefined,
		tool = "Agent",
		root = project,
	}: {
		env?: Record<string, string>;
		cwd?: string | undefined;
		tool?: string;
		root?: string;
	} = {},
) => {
	const r = runCore(
		"guard-blind-dispatch",
		{
			session_id: "s1",
			tool_name: tool,
			...(cwd === undefined ? {} : { cwd }),
			tool_input: {
				description: "score photos",
				subagent_type: "general-purpose",
				...input,
			},
		},
		{ root, env },
	);
	logs.push(...r.logs);
	return r.output;
};

const reasonOf = (out: ReturnType<typeof run>): string => {
	expect(out?.permissionDecision).toBe("deny");
	return out?.permissionDecisionReason as string;
};

beforeEach(() => {
	dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "blind-dispatch-")),
	);
	project = path.join(dir, "project");
	fs.mkdirSync(project);
	git("init", "-q", "-b", "trunk");
	commit("Set C005 to a score of 1");
	logs = [];
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("an unchecked blind dispatch is refused with its snapshot", () => {
	it("prints the branch, the subjects, the status and the line to add, as today's text", () => {
		fs.writeFileSync(path.join(project, "c009-expected.txt"), "2");
		const head = git("rev-parse", "--short", "HEAD");
		const reason = reasonOf(run({ prompt: "Score photo C005 blind." }));
		expect(reason).toBe(
			`This dispatch reads as blind, and the subagent will start with this git snapshot, taken now:

Branch: trunk
Recent commits:
  ${head} Set C005 to a score of 1
Status:
  ?? c009-expected.txt

If any of it names an item under test or its expected answer, do not send it: hold your own commit until the run reports, or run the blind work through the recipe in docs/agents/blind-dispatch.md, which starts it with no snapshot. If none does, add this line to the prompt and re-send:

Blind-checked: ${head}

Not a blind dispatch? Add the line anyway; the word "blind" is all this guard reads (#1783).`,
		);
	});

	it("says the tree is clean where status names nothing", () => {
		expect(reasonOf(run({ prompt: "blind run" }))).toContain(
			"Status:\n  (clean)\n",
		);
	});

	it("reads the description as well as the prompt", () => {
		reasonOf(run({ prompt: "Score photo C005.", description: "blind scorer" }));
	});

	it("caps a long status at twenty lines and counts the rest", () => {
		for (let i = 0; i < 23; i++)
			fs.writeFileSync(path.join(project, `f${i}.txt`), "");
		const reason = reasonOf(run({ prompt: "blind run" }));
		expect(reason).toContain("… and 3 more");
		expect(reason.match(/^ {2}\?\? /gm)).toHaveLength(20);
	});

	it("says so when the line names no commit here", () => {
		const reason = reasonOf(
			run({ prompt: "blind run\nBlind-checked: deadbeef1" }),
		);
		expect(reason).toMatch(
			/^Its `Blind-checked: deadbeef1` names no commit in this repository\. This dispatch reads as blind/,
		);
		expect(reason).toContain("Recent commits:");
	});
});

describe("a check is good for the HEAD it names", () => {
	it("passes a line naming the current HEAD, short or full", () => {
		const short = git("rev-parse", "--short", "HEAD");
		const full = git("rev-parse", "HEAD");
		expect(run({ prompt: `blind run\nBlind-checked: ${short}` })).toBeNull();
		expect(run({ prompt: `blind run\n  Blind-checked: ${full}` })).toBeNull();
	});

	it("refuses a line HEAD has moved past, naming what landed since", () => {
		const old = git("rev-parse", "--short", "HEAD");
		const now = commit("Move C009's line to 2 or more");
		const reason = reasonOf(
			run({ prompt: `blind run\nBlind-checked: ${old}` }),
		);
		expect(reason).toBe(
			`This blind dispatch's \`Blind-checked: ${old}\` is no longer HEAD. Commits landed since, which its snapshot would show:
  ${now} Move C009's line to 2 or more

If none names an item under test or its expected answer, change the line to \`Blind-checked: ${now}\` and re-send. If one does, run the blind work through the recipe in docs/agents/blind-dispatch.md (#1783).`,
		);
	});

	it("says HEAD moved elsewhere where the named commit is not behind it", () => {
		const old = git("rev-parse", "--short", "HEAD");
		git("checkout", "-q", "-b", "side");
		const ahead = commit("On the side");
		git("checkout", "-q", "trunk");
		expect(old).not.toBe(ahead);
		const reason = reasonOf(
			run({ prompt: `blind run\nBlind-checked: ${ahead}` }),
		);
		expect(reason).toContain(
			"  (none on HEAD's own line — HEAD moved elsewhere)",
		);
	});
});

describe("dispatches with no snapshot to leak pass", () => {
	it.each(["Explore", "Plan"])("passes %s, which starts with none", (type) => {
		expect(run({ prompt: "blind run", subagent_type: type })).toBeNull();
	});

	it.each(["1", "true", "ON", "yes"])(
		"passes the recipe's child, CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=%s",
		(value) => {
			expect(
				run(
					{ prompt: "blind run" },
					{ env: { CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: value } },
				),
			).toBeNull();
		},
	);

	it("passes a cwd outside any repository", () => {
		const outside = path.join(dir, "outside");
		fs.mkdirSync(outside);
		expect(run({ prompt: "blind run" }, { cwd: outside })).toBeNull();
	});

	it("passes an unborn branch", () => {
		const unborn = path.join(dir, "unborn");
		fs.mkdirSync(unborn);
		spawnSync("git", ["-C", unborn, "init", "-q"]);
		expect(run({ prompt: "blind run" }, { cwd: unborn })).toBeNull();
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
		expect(reason).toBe(
			"A fork inherits this session's whole context, so it is never blind: it knows everything you know about the answer. Dispatch the blind work as a fresh subagent (any type but fork), under the rule in docs/agents/blind-dispatch.md (#1783).",
		);
	});
});

describe("dispatches that are not blind pass", () => {
	it.each([
		"Review this diff for bugs.",
		"Look for blind spots in the guard.",
		"Name the blind-spot it misses.",
		"Its blindspots are listed.",
	])("passes the prompt %s", (prompt) => {
		expect(run({ prompt })).toBeNull();
	});

	it("passes another tool's blind input, should the matcher widen", () => {
		expect(run({ prompt: "blind run" }, { tool: "Skill" })).toBeNull();
	});

	it("leaves a dispatch with no prompt alone, recorded", () => {
		expect(
			runCore(
				"guard-blind-dispatch",
				{ tool_name: "Agent", tool_input: {} },
				{ root: project },
			).logs,
		).toContain("no prompt in payload — agent dispatch allowed unchecked");
	});
});

describe("the cases a mutant must not survive (#2791)", () => {
	it.each(["blinded run", "its blindness", "BLIND run"])(
		"refuses %s, the word's other forms",
		(prompt) => {
			reasonOf(run({ prompt }));
		},
	);

	it("refuses blind before a no-break space and spot, PCRE's \\s being ASCII", () => {
		reasonOf(run({ prompt: "score it blind spot" }));
	});

	it("refuses a line ending on blind whose next line says spot, as grep read it line by line", () => {
		reasonOf(run({ prompt: "score it blind\nspot checks follow" }));
	});

	it("reads the last Blind-checked line", () => {
		const head = git("rev-parse", "--short", "HEAD");
		expect(
			run({
				prompt: `blind\nBlind-checked: deadbeef1\nBlind-checked: ${head}`,
			}),
		).toBeNull();
		reasonOf(
			run({
				prompt: `blind\nBlind-checked: ${head}\nBlind-checked: deadbeef1`,
			}),
		);
	});

	it("ignores a Blind-checked line in the description", () => {
		const head = git("rev-parse", "--short", "HEAD");
		reasonOf(
			run({ prompt: "blind run", description: `Blind-checked: ${head}` }),
		);
	});

	it("reads git in the payload's cwd, falling back to the host root", () => {
		const other = path.join(dir, "other");
		fs.mkdirSync(other);
		const head = git("rev-parse", "--short", "HEAD");
		/* The host root has no repository: only the cwd's HEAD can pass. */
		expect(
			run({ prompt: `blind run\nBlind-checked: ${head}` }, { root: other }),
		).toBeNull();
		reasonOf(run({ prompt: "blind run" }, { cwd: undefined }));
	});

	it("caps the commits landed since at twenty", () => {
		const old = git("rev-parse", "--short", "HEAD");
		for (let i = 0; i < 22; i++) commit(`c${i}`);
		const reason = reasonOf(
			run({ prompt: `blind run\nBlind-checked: ${old}` }),
		);
		expect(reason.match(/^ {2}[0-9a-f]+ c\d+$/gm)).toHaveLength(20);
	});
});
