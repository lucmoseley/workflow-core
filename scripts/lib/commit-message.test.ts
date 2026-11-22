// @vitest-environment node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordedLines } from "./commit-message.js";
import { initGitRepo, mkScratchDir } from "./git-fixture";
import { inProgramScope } from "./program-scope.js";

const SCISSORS = "# ------------------------ >8 ------------------------";

let dir: string;
beforeEach(() => {
	dir = mkScratchDir("commit-message-");
	initGitRepo(dir, path.join(dir, ".git", "hooks"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function recorded(raw: string, editor: string, cleanup?: string) {
	if (cleanup !== undefined)
		spawnSync("git", ["config", "commit.cleanup", cleanup], { cwd: dir });
	return inProgramScope(
		{ cwd: dir, env: { ...process.env, GIT_EDITOR: editor } },
		() => recordedLines(raw),
	);
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
});
