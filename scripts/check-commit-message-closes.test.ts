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
 * Its branch cases call main in process; its boundary set runs the .sh path
 * the hooks run, through `bash`, over a file on disk.
 *
 * .husky/commit-msg and .husky/prepare-commit-msg refuse a commit on its hit:
 * a false pass lets a message close an issue server-side on the push, with no
 * resolution comment and no `**Outstanding:**` line, and a false fail refuses
 * a commit that only mentions an issue.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mkScratchDir } from "./lib/git-fixture";
import { registerTempCleanup } from "./lib/precommit-gate-harness";
import { ROOT } from "./lib/precommit-gate-testkit";

const { main } = require("./check-commit-message-closes.js") as {
	main: (argv: string[]) => { code: number; stderr: string };
};

const SCANNER = path.join(ROOT, "scripts", "check-commit-message-closes.sh");
const temps = registerTempCleanup();

/** `message` written to a message file on disk; its path. */
function messageFile(message: string) {
	const dir = mkScratchDir("closing-keyword-");
	temps.push(dir);
	const file = path.join(dir, "COMMIT_EDITMSG");
	fs.writeFileSync(file, message);
	return file;
}

/** The scanner in process over `message`: its exit code and stderr. */
function scan(message: string) {
	const { code, stderr } = main([messageFile(message), "test"]);
	return { code, output: stderr };
}

/** The scanner as the hooks run it: `bash` on the .sh path. */
function scanSpawned(file: string) {
	try {
		execFileSync("bash", [SCANNER, file, "test"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: 0, output: "" };
	} catch (e) {
		const err = e as { status?: number; stdout?: string; stderr?: string };
		return {
			code: err.status ?? 1,
			output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
		};
	}
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

describe("the .sh path the hooks run (boundary set)", () => {
	it("refuses a closing message on stderr with exit 1", () => {
		const r = scanSpawned(messageFile("Fixes #12 do a thing\n"));
		expect(r.code).toBe(1);
		expect(r.output).toContain("test: this commit message closes an issue");
		expect(r.output).toContain("What matched: `Fixes #12`");
		expect(r.output).toContain(
			"Rewrite the message with a non-closing reference and commit again.",
		);
	});

	it("passes a clean message silently with exit 0", () => {
		expect(scanSpawned(messageFile("Refs #12 do a thing\n"))).toEqual({
			code: 0,
			output: "",
		});
	});

	it("refuses an unreadable message file with exit 1", () => {
		const r = scanSpawned("/nonexistent/COMMIT_EDITMSG");
		expect(r.code).toBe(1);
		expect(r.output).toContain("cannot read the commit message file");
		expect(r.output).toContain("Refusing rather than passing a message");
	});
});
