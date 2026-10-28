// @vitest-environment node
/*
 * Pins a commit message file's lines as git records them (#2884, #3075),
 * through the CLI check-commit-subject.sh runs, in a fixture repository so
 * `commit.cleanup` is read from config as a hook reads it: `#` lines dropped
 * in `strip` mode alone, and nothing from the scissors line on in `strip` and
 * `scissors` modes, so a `--verbose` diff below it never reaches the subject,
 * closing or `Weakens:` readers.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initGitRepo, mkScratchDir } from "./git-fixture";
import { runInProcess } from "./run-in-process.js";

const CLI = path.join(__dirname, "commit-message.js");
const SCISSORS = "# ------------------------ >8 ------------------------";

let dir: string;
beforeEach(() => {
	dir = mkScratchDir("commit-message-");
	initGitRepo(dir, path.join(dir, ".git", "hooks"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The lines the CLI prints for `raw`, under `editor` and `cleanup`. */
function recorded(raw: string, editor: string, cleanup?: string) {
	if (cleanup !== undefined)
		spawnSync("git", ["config", "commit.cleanup", cleanup], { cwd: dir });
	const file = path.join(dir, "MSG");
	fs.writeFileSync(file, raw);
	const r = runInProcess(CLI, [file], {
		cwd: dir,
		env: { ...process.env, GIT_EDITOR: editor },
	});
	expect(r.status, r.stderr).toBe(0);
	return r.stdout.split("\n").slice(0, -1);
}

const RAW = `#123 subject\n# On branch main\nBody\n${SCISSORS}\n+Fixes #12`;
const ALL = [
	"#123 subject",
	"# On branch main",
	"Body",
	SCISSORS,
	"+Fixes #12",
];

describe("the lines git records, per cleanup mode", () => {
	it.each([
		["the editor, cleanup unset", "vi", undefined, ["Body"]],
		["the editor, cleanup default", "vi", "default", ["Body"]],
		["-m or -F, cleanup unset", ":", undefined, ALL],
		["-m or -F, cleanup strip", ":", "strip", ["Body"]],
		["the editor, cleanup whitespace", "vi", "whitespace", ALL],
		["the editor, cleanup verbatim", "vi", "verbatim", ALL],
		[
			"the editor, cleanup scissors",
			"vi",
			"scissors",
			["#123 subject", "# On branch main", "Body"],
		],
	])("%s", (_, editor, cleanup, expected) => {
		expect(recorded(RAW, editor, cleanup)).toEqual(expected);
	});

	it("keeps a line that only mentions >8 without the scissors shape", () => {
		expect(recorded("a >8 b\n", "vi")).toEqual(["a >8 b", ""]);
	});

	it("refuses a call naming no message file", () => {
		const r = runInProcess(CLI, [], { cwd: dir });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("usage:");
	});
});
