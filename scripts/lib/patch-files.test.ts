// @vitest-environment node
/*
 * lib/patch-files.js's contract (#2740). Plain strings pin the parse; one
 * real patch pins that git's own output for a tabbed path is what the parse
 * expects. A path cut short is left out of `--patch`'s files, so commit-paths
 * would take the working-tree copy whole.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { numstatPaths } from "./patch-files.js";

describe("numstatPaths", () => {
	let repo = "";
	afterEach(() => {
		if (repo) fs.rmSync(repo, { recursive: true, force: true });
	});

	it("reads a binary file's dashes as counts", () => {
		expect(numstatPaths("1\t0\ta.js\0-\t-\timg.png\0")).toEqual([
			"a.js",
			"img.png",
		]);
	});

	it("throws on a field with no path", () => {
		expect(() => numstatPaths("1\t0\0")).toThrow("no path");
	});

	it("keeps a tabbed path whole, from git's own output", () => {
		repo = fs.mkdtempSync(path.join(os.tmpdir(), "patch-files-"));
		const git = (args: string[], input?: string) =>
			execFileSync(
				"git",
				["-c", "user.email=t@t", "-c", "user.name=t", ...args],
				{ cwd: repo, encoding: "utf8", input },
			);
		git(["init", "-q"]);
		fs.writeFileSync(path.join(repo, "a\tb.js"), "one\n");
		git(["add", "-A"]);
		git(["commit", "-qm", "seed"]);
		fs.writeFileSync(path.join(repo, "a\tb.js"), "two\n");
		const patch = git(["diff", "-U0"]);
		const out = git(["apply", "--numstat", "-z", "--unidiff-zero", "-"], patch);
		expect(numstatPaths(out)).toEqual(["a\tb.js"]);
	});
});
