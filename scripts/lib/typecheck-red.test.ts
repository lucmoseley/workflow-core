// @vitest-environment node
/*
 * The PostToolUse Bash core handing a session its
 * commit's RED pre-commit type-check, and the store behind it.
 *
 * Breaking it leaves a RED try piped through `tail` to be heard first from CI
 * (#3824), or repeats one report on every Bash call.
 *
 * Built on a real git repository and the real store, as the record is found
 * through git's common directory, which a fake would not cross.
 *
 * The seam-2 case (#4242) runs it from a linked worktree of a main checkout,
 * CLAUDE_PROJECT_DIR on the main one: the record is taken from the main
 * checkout's store.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCore, splitCheckout } from "./guard-core-testkit";
import { recordRed, takeRed } from "./typecheck-red-host.js";

const SID = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-2222-3333-4444-555555555555";
const log = () => undefined;
const RECORDER = path.join(__dirname, "..", "record-typecheck-red.js");
const COMMAND = "npm run typecheck";

let root: string;

const bash = (sid: string, extra: object = {}) => {
	const r = runCore(
		"guard-typecheck-red",
		{
			session_id: sid,
			tool_name: "Bash",
			tool_input: { command: "ls" },
			...extra,
		},
		{ root, event: "PostToolUse" },
	);
	return r.output?.additionalContext ?? "";
};

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tc-red-")));
	execFileSync("git", ["init", "-q", "-b", "main", root]);
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("guard-typecheck-red", () => {
	it("hands over the command and output once", () => {
		recordRed(root, SID, { command: COMMAND, output: "a.ts: error TS1" });
		const said = bash(SID);
		expect(said).toContain("pre-commit type-check ran RED at");
		expect(said).toContain(COMMAND);
		expect(said).toContain("a.ts: error TS1");
		expect(bash(SID)).toBe("");
	});

	it("says nothing with no record", () => {
		expect(bash(SID)).toBe("");
	});

	it("never hands over a neighbour's record", () => {
		recordRed(root, OTHER, { command: COMMAND, output: "e" });
		expect(bash(SID)).toBe("");
		expect(bash(OTHER)).toContain("ran RED");
	});

	it("leaves the record for the main thread on a subagent's answer", () => {
		recordRed(root, SID, { command: COMMAND, output: "e" });
		expect(bash(SID, { agent_id: "abc" })).toBe("");
		expect(bash(SID)).toContain("ran RED");
	});

	it("says where it cut a long output", () => {
		recordRed(root, SID, { command: COMMAND, output: "x".repeat(5000) });
		const said = bash(SID);
		expect(said).toContain("cut here");
		expect(said).not.toContain("x".repeat(2001));
	});

	it("reads a commit in a linked worktree's record from the main checkout", () => {
		execFileSync("git", [
			"-C",
			root,
			"-c",
			"user.email=t@t",
			"-c",
			"user.name=t",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"init",
		]);
		const tree = path.join(root, "wt");
		execFileSync("git", ["-C", root, "worktree", "add", "-q", tree]);
		recordRed(tree, SID, { command: COMMAND, output: "e" });
		expect(bash(SID)).toContain("ran RED");
	});
});

describe("a Bash answer to a session in its own worktree (#4242)", () => {
	it("takes the record from the main checkout's store, once", () => {
		const at = splitCheckout(path.join(root, "split"));
		recordRed(at.main, SID, { command: COMMAND, output: "e" });
		const fromWorktree = () =>
			runCore(
				"guard-typecheck-red",
				{ session_id: SID, tool_name: "Bash", tool_input: { command: "ls" } },
				{ root: at.main, worktree: at.worktree, event: "PostToolUse" },
			).output?.additionalContext ?? "";
		expect(fromWorktree()).toContain("ran RED");
		expect(takeRed(at.main, SID, log)).toBeNull();
		expect(fromWorktree()).toBe("");
	});
});

describe("the recorder", () => {
	it("says a record that did not land, and exits 0", () => {
		fs.writeFileSync(path.join(root, ".claude"), "a file in the way");
		// spawn-kept: a real fd, as the recorder reads the hook's pipe on stdin.
		const r = spawnSync("node", [RECORDER, "--", COMMAND], {
			cwd: root,
			input: "e",
			env: {
				...process.env,
				CLAUDE_CODE_SESSION_ID: SID,
				CLAUDE_PROJECT_DIR: root,
			},
			encoding: "utf8",
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("not recorded");
	});
});

describe("the store", () => {
	it("keeps the newer of two tries", () => {
		recordRed(root, SID, { command: COMMAND, output: "old" });
		recordRed(root, SID, { command: COMMAND, output: "new" });
		expect(takeRed(root, SID, log)?.output).toBe("new");
	});

	it("drops a record it cannot read, and leaves nothing behind", () => {
		recordRed(root, SID, { command: COMMAND, output: "e" });
		const dir = path.join(root, ".claude", "tmp", "markers");
		const file = path.join(dir, `.typecheck-red-${SID}`);
		fs.writeFileSync(file, "{");
		const logged: string[] = [];
		expect(takeRed(root, SID, (s: string) => logged.push(s))).toBeNull();
		expect(logged.join()).toContain("a RED record went unread");
		expect(fs.readdirSync(dir)).toEqual([]);
	});

	it("returns null outside a repository", () => {
		const bare = fs.mkdtempSync(path.join(os.tmpdir(), "tc-red-bare-"));
		expect(takeRed(bare, SID, log)).toBeNull();
		fs.rmSync(bare, { recursive: true, force: true });
	});
});
