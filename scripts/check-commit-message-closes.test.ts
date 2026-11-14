// @vitest-environment node

/*
 * scripts/check-commit-message-closes.js (#138) — what the scanner matches,
 * given a message file.
 *
 * The seam it is wired into — which git hook fires on which route — is
 * scripts/prepare-commit-msg-gate.test.ts's. This file is about the message
 * text alone, and about the two things git puts in a message file that would
 * otherwise fire: its own `#` template block, and the `--verbose` diff below
 * the scissors line, which is NOT comment-prefixed.
 *
 * Every case calls main in process, over a file on disk, as the two hooks'
 * dispatchers run it.
 *
 * .husky/commit-msg and .husky/prepare-commit-msg refuse a commit on its hit:
 * a false pass lets a message close an issue server-side on the push, with no
 * resolution comment and no `**Outstanding:**` line, and a false fail refuses
 * a commit that only mentions an issue.
 */

import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkScratchDir } from "./lib/git-fixture";
import { registerTempCleanup } from "./lib/precommit-gate-harness";

const { main } = require("./check-commit-message-closes.js") as {
	main: (argv: string[]) => { code: number; stderr: string };
};

const temps = registerTempCleanup();

/** `message` written to a message file on disk; its path. */
function messageFile(message: string) {
	const dir = mkScratchDir("closing-keyword-");
	temps.push(dir);
	const file = path.join(dir, "COMMIT_EDITMSG");
	fs.writeFileSync(file, message);
	return file;
}

/* lib/commit-message.js reads the hook's cleanup mode from GIT_EDITOR, which
 * git sets to `:` for a pre-commit test gate on a `-m` commit: pinned to the
 * editor route, where git drops `#` lines. */
beforeEach(() => {
	vi.stubEnv("GIT_EDITOR", "vi");
});

/** The scanner in process over `message`: its exit code and stderr. */
function scan(message: string) {
	const { code, stderr } = main([messageFile(message), "test"]);
	return { code, output: stderr };
}

describe("check-commit-message-closes.js (#138)", () => {
	it.each([
		["Fixes #12 do a thing\n", "Fixes #12"],
		["Closed #12\n", "Closed #12"],
		["resolve #12\n", "resolve #12"],
		["do a thing\n\nCloses: #12\n", "Closes: #12"],
		[
			"do it\n\nFixed lucmoseley/workflow-core-tracker#7\n",
			"Fixed lucmoseley/workflow-core-tracker#7",
		],
		[
			"do it\n\nresolves https://github.com/lucmoseley/workflow-core-tracker/issues/7\n",
			"resolves https://github.com/lucmoseley/workflow-core-tracker/issues/7",
		],
	])("refuses %j, naming what matched", (message, matched) => {
		const r = scan(message as string);
		expect(r.code).toBe(1);
		expect(r.output).toContain(`What matched: \`${matched}\``);
	});

	it.each([
		["a non-closing reference", "Refs #12 do a thing\n"],
		["a word ending in a keyword", "postfixes #12 nothing\n"],
		["git's own template block", "do it\n# Fixes #12 in a template line\n"],
		[
			"the --verbose diff below the scissors line",
			"do it\n# ------------------------ >8 ------------------------\ndiff --git a/x b/x\n+Fixes #12\n",
		],
		[
			"a revert's quoted subject",
			'Revert "Fixes #77 add g"\n\nThis reverts commit abc.\n',
		],
	])("passes %s", (_name, message) => {
		expect(scan(message as string).code).toBe(0);
	});

	it("refuses rather than passing a message file it cannot read", () => {
		const r = main(["/nonexistent/COMMIT_EDITMSG", "test"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("cannot read the commit message file");
		expect(r.stderr).toContain("Refusing rather than passing a message");
	});
});

describe("as the hooks run it", () => {
	it("refuses a closing message on stderr with exit 1", () => {
		const r = scan("Fixes #12 do a thing\n");
		expect(r.code).toBe(1);
		expect(r.output).toContain("test: this commit message closes an issue");
		expect(r.output).toContain("What matched: `Fixes #12`");
		expect(r.output).toContain(
			"Rewrite the message with a non-closing reference and commit again.",
		);
	});

	it("passes a clean message silently with exit 0", () => {
		expect(scan("Refs #12 do a thing\n")).toEqual({ code: 0, output: "" });
	});

	it.each([
		["-m or -F (no editor), keeping it as the subject, so refuses", ":", 1],
		["the editor, dropping it as a comment, so passes", "vi", 0],
	])("reads a #N line as git records it on %s (#3075)", (_, editor, code) => {
		vi.stubEnv("GIT_EDITOR", editor as string);
		expect(scan("#3 Fixes #12 do a thing\n").code).toBe(code);
	});
});
