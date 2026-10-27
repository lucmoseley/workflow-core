// @vitest-environment node
/*
 * Over the working-tree read shared by the Stop guard and
 * `run-vitest --isolated` (mantahostels#2196): pins the exact set of dirty and
 * untracked paths it names, and null rather than an empty set where git will
 * not answer.
 *
 * WHAT BREAKS IF THESE GO WRONG: both refusals name the files a session must
 * commit. A missed path lets work be lost silently; a spurious one sends a
 * session to commit a neighbour's bytes (mantahostels#63).
 *
 * A throwaway repo per test. Never this repo's own working tree: what is dirty
 * here changes under a parallel session mid-run, and every assertion below is
 * about an exact set.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const tree: any = createRequire(__filename)("./dirty-tree.js");

let dir: string;
const made: string[] = [];

const tmp = (prefix: string) => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	made.push(d);
	return d;
};

const git = (args: string[], cwd = dir) =>
	execFileSync("git", args, { encoding: "utf8", cwd }).trim();

const write = (p: string, body: string) => {
	fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
	fs.writeFileSync(path.join(dir, p), body);
};

beforeEach(() => {
	dir = tmp("dirty-tree-");
	git(["init", "-q", "-b", "main"], dir);
	git(["config", "user.email", "t@example.invalid"]);
	git(["config", "user.name", "Test"]);
	write("a.txt", "one\n");
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "base"]);
});

afterEach(() => {
	for (const d of made.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
});

describe("readDirtyTracked", () => {
	it("names a modified tracked file and no untracked one", () => {
		write("a.txt", "two\n");
		write("scratch.tmp", "x\n");
		expect(tree.readDirtyTracked(dir)).toEqual(["a.txt"]);
	});

	it("reads a rename's source path as well as its destination, sorted", () => {
		// Porcelain emits the DESTINATION first, so this is also the case that pins
		// the sort (mantahostels#2196).
		git(["mv", "a.txt", "b.txt"]);
		expect(tree.readDirtyTracked(dir)).toEqual(["a.txt", "b.txt"]);
	});

	it("reads a path holding a space unquoted, so it matches a ledger entry", () => {
		write("two words.txt", "x\n");
		git(["add", "-A"]);
		git(["commit", "-q", "-m", "spaced"]);
		write("two words.txt", "y\n");
		expect(tree.readDirtyTracked(dir)).toEqual(["two words.txt"]);
	});

	it("answers [] on a clean repo", () => {
		expect(tree.readDirtyTracked(dir)).toEqual([]);
	});

	it("answers null where git will not answer, never an empty set", () => {
		const outside = tmp("not-a-repo-");
		expect(tree.readDirtyTracked(outside)).toBeNull();
	});
});

describe("readUntrackedFiles", () => {
	it("names an untracked file that `readDirtyTracked`'s -uno drops", () => {
		write("new.ts", "x\n");
		expect(tree.readUntrackedFiles(dir)).toEqual(["new.ts"]);
	});

	it("honours .gitignore, so build output is not offered as work", () => {
		write(".gitignore", "ignored/\n");
		write("ignored/out.js", "x\n");
		expect(tree.readUntrackedFiles(dir)).toEqual([".gitignore"]);
	});

	it("answers [] where there is nothing untracked", () => {
		expect(tree.readUntrackedFiles(dir)).toEqual([]);
	});

	it("answers null where git will not answer", () => {
		const outside = tmp("not-a-repo-");
		expect(tree.readUntrackedFiles(outside)).toBeNull();
	});
});

describe("readUntrackedEntries", () => {
	/* The reason it exists apart from `readUntrackedFiles`. */
	it("collapses an untracked directory to one entry", () => {
		write("stray-dir/one.out", "x\n");
		write("stray-dir/two.out", "x\n");
		expect(tree.readUntrackedEntries(dir)).toEqual(["stray-dir/"]);
		/* The other reader walks the same directory out, and both are wanted. */
		expect(tree.readUntrackedFiles(dir)).toEqual([
			"stray-dir/one.out",
			"stray-dir/two.out",
		]);
	});

	it("names an untracked file and drops a modified tracked one", () => {
		write("a.txt", "two\n");
		write("scratch.out", "x\n");
		expect(tree.readUntrackedEntries(dir)).toEqual(["scratch.out"]);
	});

	/* A rename's source rides in a field of its own with no status letters, so a
	 * walker that did not skip it would read a source named "?? x" as an entry. */
	it("does not read a rename's source field as an entry", () => {
		write("?? spoof.out", "x\n");
		git(["add", "-A"]);
		git(["commit", "-q", "-m", "spoof"]);
		git(["mv", "?? spoof.out", "moved.out"]);
		expect(tree.readUntrackedEntries(dir)).toEqual([]);
	});

	it("honours .gitignore, which is the whole of the `.claude/tmp/` exclusion", () => {
		write(".gitignore", ".claude/tmp/\n");
		write(".claude/tmp/notes.md", "x\n");
		expect(tree.readUntrackedEntries(dir)).toEqual([".gitignore"]);
	});

	it("answers [] where there is nothing untracked", () => {
		expect(tree.readUntrackedEntries(dir)).toEqual([]);
	});

	it("answers null where git will not answer, never an empty set", () => {
		const outside = tmp("not-a-repo-");
		expect(tree.readUntrackedEntries(outside)).toBeNull();
	});
});

describe("shellWord", () => {
	it("leaves an ordinary path bare", () => {
		expect(tree.shellWord("scripts/lib/dirty-tree.js")).toBe(
			"scripts/lib/dirty-tree.js",
		);
	});

	it("quotes a path holding a space", () => {
		expect(tree.shellWord("two words.txt")).toBe("'two words.txt'");
	});

	it("survives a path holding a single quote", () => {
		// The escape has to close, escape and reopen.
		const quoted = tree.shellWord("it's.txt");
		expect(quoted).toBe(`'it'\\''s.txt'`);
		expect(
			execFileSync("sh", ["-c", `printf %s ${quoted}`], {
				encoding: "utf8",
			}),
		).toBe("it's.txt");
	});

	it("leaves a ref or script name bare, and quotes a ~ bash would expand (#2284)", () => {
		const words = ["HEAD~1", "test:changed", "--full=flake", "~/x", "a=~/x"];
		const shell = words.map(tree.shellWord);
		expect(shell.slice(0, 3)).toEqual(words.slice(0, 3));
		expect(
			execFileSync("bash", ["-c", `printf '%s\\n' ${shell.join(" ")}`], {
				encoding: "utf8",
			}),
		).toBe(`${words.join("\n")}\n`);
	});
});
