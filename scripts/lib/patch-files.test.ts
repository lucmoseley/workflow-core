// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineTemplate } from "./git-fixture";
import { numstatPaths } from "./patch-files.js";

const gitIn = (cwd: string, args: string[], input?: string) =>
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd,
		encoding: "utf8",
		input,
	});

describe("numstatPaths", () => {
	let repo = "";
	const tabbed = defineTemplate((dir) => {
		gitIn(dir, ["init", "-q"]);
		fs.writeFileSync(path.join(dir, "a\tb.js"), "one\n");
		gitIn(dir, ["add", "-A"]);
		gitIn(dir, ["commit", "-qm", "seed"]);
	});
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
		repo = tabbed.instantiate(
			fs.mkdtempSync(path.join(os.tmpdir(), "patch-files-")),
		);
		const git = (args: string[], input?: string) => gitIn(repo, args, input);
		fs.writeFileSync(path.join(repo, "a\tb.js"), "two\n");
		const patch = git(["diff", "-U0"]);
		const out = git(["apply", "--numstat", "-z", "--unidiff-zero", "-"], patch);
		expect(numstatPaths(out)).toEqual(["a\tb.js"]);
	});
});
