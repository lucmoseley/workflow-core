// @vitest-environment node
/*
 * Pins which named paths commit-paths refuses before writing anything, that a
 * commit carries exactly the named paths (or, under `--patch`, only the
 * session's own lines), and how a hook refusal leaves the index for a re-run.
 *
 * commit-paths.js, driven through its command line against a real temporary
 * repository (#583; the seam ruled on #502, Q1 (A)).
 *
 * Every refusal also asserts the index is untouched.
 *
 * spawn-kept: one case asserts the process boundary — module resolution must
 * start from a tree with no node_modules above it and no NODE_PATH.
 *
 * It is the commit route `CLAUDE.md`'s pathspec rule and
 * the guard-commit-form core send every session down: loosen a case and a
 * commit sweeps in work it was not handed, or leaves a new file behind.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { freshSandbox, live, store } from "./lib/arbiter-testkit";
import { readText } from "./lib/file-read.js";
import { defineTemplate, initGitRepo } from "./lib/git-fixture";
import { installLib } from "./lib/lib-install-testkit";
import {
	cutPostCommitBlock,
	plantSequencer,
	ROOT,
} from "./lib/precommit-gate-testkit";
import { runInProcess } from "./lib/run-in-process";
import { shellQuote } from "./lib/sh-quote.js";

const SCRIPT = path.resolve(__dirname, "commit-paths.js");

/* Built once and copied per case; each copy points its hooks at its own
 * sandbox, a path the template cannot know. The placeholder hooks directory
 * is removed so no copy carries it as an untracked directory. */
const repoTemplate = defineTemplate((dir) => {
	const none = path.join(dir, ".git-no-hooks");
	fs.mkdirSync(none);
	initGitRepo(dir, none);
	fs.rmdirSync(none);
});
let hooks = "";
const sb = freshSandbox((s) => {
	hooks = path.join(s.dir, "hooks");
	fs.mkdirSync(hooks);
	repoTemplate.instantiate(s.repo);
	execFileSync("git", ["config", "core.hooksPath", hooks], { cwd: s.repo });
});

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: sb.repo, encoding: "utf8" });

const write = (rel: string, text = `${rel}\n`) => {
	fs.mkdirSync(path.dirname(path.join(sb.repo, rel)), { recursive: true });
	fs.writeFileSync(path.join(sb.repo, rel), text);
};

/** With no `stdin`, the script's read of fd 0 reaches the test process's own. */
const run = (
	args: string[],
	{ cwd = sb.repo, stdin }: { cwd?: string; stdin?: string } = {},
) => runInProcess(SCRIPT, args, { cwd, env: { ...process.env }, stdin });

const readIndex = () => git("ls-files", "--stage");
const readHead = () => git("rev-parse", "HEAD").trim();
/** `ref`'s subject, then one `<status>\t<path>` line per file it changed. */
const readCommitted = (ref = "HEAD") =>
	git("show", "--name-status", "--format=%s", ref).replace("\n\n", "\n").trim();

const runWith = (args: string[], env: NodeJS.ProcessEnv) =>
	runInProcess(SCRIPT, args, { cwd: sb.repo, env });
/** The outcome log's last line, split on its tabs. */
const readLastOutcome = () =>
	fs
		.readFileSync(store.paths.commitPathsLog(), "utf8")
		.trim()
		.split("\n")
		.at(-1)
		?.split("\t");

/** A pre-commit that refuses while `gate-refuses` exists in the repo root. */
const gate = () => {
	const hook = path.join(hooks, "pre-commit");
	fs.writeFileSync(
		hook,
		'#!/bin/sh\nif [ -f gate-refuses ]; then echo "gate: fix the widget" >&2; exit 1; fi\n',
	);
	fs.chmodSync(hook, 0o755);
};

describe("refusals — exit 2, nothing written to the index", () => {
	const refused = (args: string[], message: RegExp) => {
		const before = readIndex();
		const tip = readHead();
		const r = run(args);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(message);
		expect(r.stderr).toContain("Nothing written");
		expect(readIndex()).toBe(before);
		expect(readHead()).toBe(tip);
		return r;
	};

	it("refuses a call with no paths, saying why a bare commit is unsafe", () => {
		refused(
			["-m", "x", "--"],
			/no paths after `--`.*whatever the index holds/s,
		);
		refused(["-m", "x"], /no paths/);
	});

	it("refuses a path that exists nowhere, telling the session to check the spelling", () => {
		write("new.md");
		refused(
			["-m", "x", "--", "new.md", "typo.md"],
			/typo\.md exists nowhere.*Check the spelling/s,
		);
	});

	it("refuses a gitignored path, naming the matching rule", () => {
		write(".gitignore", "*.log\n");
		git("add", ".gitignore");
		git("commit", "-qm", "ignore logs");
		write("debug.log");
		refused(
			["-m", "x", "--", "debug.log"],
			/debug\.log is ignored \(\.gitignore:1:\*\.log\s+debug\.log\).*change the ignore rule first/s,
		);
	});

	it("refuses a directory holding untracked files, listing each one — git would leave them behind with exit 0 (mantahostels#1651)", () => {
		write("src/kept.md");
		git("add", "src/kept.md");
		git("commit", "-qm", "seed src");
		write("src/kept.md", "edited\n");
		write("src/new-a.md");
		write("src/deep/new-b.md");
		const r = refused(
			["-m", "x", "--", "src"],
			/src is a directory holding 2 file\(s\) git does not track/,
		);
		expect(r.stderr).toContain("  src/deep/new-b.md");
		expect(r.stderr).toContain("  src/new-a.md");
		expect(r.stderr).toContain("Name the ones that are yours");
	});

	it("refuses when every named path already matches HEAD, advising a check that the edit was saved", () => {
		refused(
			["-m", "x", "--", "a.md"],
			/nothing to commit.*Check the edit was saved/s,
		);
	});

	it("refuses a file untracked with `git rm --cached` and now ignored, edited or not (#2363)", () => {
		git("rm", "-q", "--cached", "a.md");
		write(".gitignore", "a.md\n");
		const rule =
			/a\.md is ignored \(\.gitignore:1:a\.md\s+a\.md\).*change the ignore rule first/s;
		refused(["-m", "x", "--", "a.md", ".gitignore"], rule);
		write("a.md", "edited\n");
		refused(["-m", "x", "--", "a.md"], rule);
	});

	it("refuses a directory untracked with `git rm -r --cached` and now ignored, naming the rule (#2363)", () => {
		write("d/x.log");
		git("add", "d");
		git("commit", "-qm", "seed d");
		git("rm", "-rq", "--cached", "d");
		write(".gitignore", "d/\n");
		refused(
			["-m", "x", "--", "d", ".gitignore"],
			/d is ignored \(\.gitignore:1:d\/\s+d\).*change the ignore rule first/s,
		);
	});

	it("refuses a directory a `!` rule re-includes as holding nothing tracked, not as ignored (#1663)", () => {
		write(".gitignore", "build*/\n!build-keep/\n");
		git("add", ".gitignore");
		git("commit", "-qm", "ignore builds but one");
		fs.mkdirSync(path.join(sb.repo, "build-keep"));
		const r = refused(
			["-m", "x", "--", "build-keep"],
			/build-keep is a directory holding nothing git tracks/,
		);
		expect(r.stderr).not.toMatch(/is ignored/);
	});

	it("refuses an empty directory, telling the session to name the files it means", () => {
		fs.mkdirSync(path.join(sb.repo, "empty"));
		refused(
			["-m", "x", "--", "empty"],
			/empty is a directory holding nothing git tracks.*Name the files/s,
		);
	});

	it("refuses --amend, -a and --no-verify as unknown options", () => {
		write("a.md", "edited\n");
		for (const flag of ["--amend", "-a", "--no-verify"])
			refused(
				[flag, "-m", "x", "--", "a.md"],
				new RegExp(`unknown option ${flag}`),
			);
	});

	it("refuses an empty message and a message given twice", () => {
		write("a.md", "edited\n");
		refused(["-m", "  ", "--", "a.md"], /no commit message/);
		refused(["-m", "x", "-m", "y", "--", "a.md"], /give the message once/);
	});
});

describe("commits — exit 0, the hash and subject printed", () => {
	const lands = (args: string[], opts?: { stdin?: string }) => {
		const r = run(args, opts);
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		const line = git("log", "-1", "--format=%h %s").trim();
		expect(r.stdout).toContain(`committed ${line}\n`);
		return r;
	};

	it("commits a file a `!` rule re-includes (#1663)", () => {
		write(".gitignore", "*.log\n!keep.log\n");
		git("add", ".gitignore");
		git("commit", "-qm", "ignore logs but one");
		write("keep.log");
		write("debug.log");
		const refusal = run(["-m", "x", "--", "debug.log"]);
		expect(refusal.status).toBe(2);
		expect(refusal.stderr).toMatch(
			/debug\.log is ignored \(\.gitignore:1:\*\.log\s+debug\.log\)/,
		);
		lands(["-m", "keep", "--", "keep.log"]);
		expect(readCommitted()).toBe("keep\nA\tkeep.log");
	});

	it("commits a single new file with no separate intent-add", () => {
		write("new.md");
		lands(["-m", "add new", "--", "new.md"]);
		expect(readCommitted()).toBe("add new\nA\tnew.md");
		expect(git("status", "--porcelain")).toBe("");
	});

	it("commits tracked and new paths together, and nothing else in the tree", () => {
		write("a.md", "edited\n");
		write("new.md");
		write("other.md");
		lands(["-m", "mixed", "--", "a.md", "new.md"]);
		expect(readCommitted()).toBe("mixed\nM\ta.md\nA\tnew.md");
		expect(git("status", "--porcelain")).toBe("?? other.md\n");
	});

	it("commits a new file inside an otherwise-tracked directory", () => {
		write("src/kept.md");
		git("add", "src/kept.md");
		git("commit", "-qm", "seed src");
		write("src/new.md");
		lands(["-m", "nested", "--", "src/new.md"]);
		expect(readCommitted()).toBe("nested\nA\tsrc/new.md");
	});

	it("commits a deleted tracked path", () => {
		fs.rmSync(path.join(sb.repo, "a.md"));
		lands(["-m", "drop a", "--", "a.md"]);
		expect(readCommitted()).toBe("drop a\nD\ta.md");
	});

	it("commits a `git mv` as a rename, its source gone from the index as well as the disk (#1794)", () => {
		git("mv", "a.md", "moved.md");
		lands(["-m", "move a", "--", "a.md", "moved.md"]);
		expect(readCommitted()).toBe("move a\nR100\ta.md\tmoved.md");
		expect(git("status", "--porcelain")).toBe("");
	});

	it("commits a `git mv` of a directory, each file under it as a rename (#1794)", () => {
		write("src/one.md");
		git("add", "src");
		git("commit", "-qm", "seed src");
		git("mv", "src", "lib");
		lands(["-m", "move src", "--", "src", "lib"]);
		expect(readCommitted()).toBe("move src\nR100\tsrc/one.md\tlib/one.md");
		expect(git("status", "--porcelain")).toBe("");
	});

	it("commits a directory whose only file went by `git mv` or `git rm`, named with an ignored file left in it (#2363)", () => {
		write(".gitignore", "*.log\n");
		write("src/one.md");
		write("src/s.log");
		write("old/two.md");
		write("old/s.log");
		git("add", ".gitignore", "src", "old");
		git("commit", "-qm", "seed src and old");
		git("mv", "src/one.md", "one.md");
		git("rm", "-q", "old/two.md");
		lands(["-m", "move one, drop two", "--", "src", "one.md", "old"]);
		expect(readCommitted()).toBe(
			"move one, drop two\nD\told/two.md\nR100\tsrc/one.md\tone.md",
		);
	});

	it("commits a new file on an unborn branch, where there is no HEAD to read, and still refuses a misspelt path", () => {
		git("checkout", "-q", "--orphan", "fresh");
		git("rm", "-rqf", "--cached", ".");
		write("new.md");
		const refusal = run(["-m", "x", "--", "new.md", "typo.md"]);
		expect(refusal.status).toBe(2);
		expect(refusal.stderr).toMatch(/typo\.md exists nowhere/);
		lands(["-m", "first", "--", "new.md"]);
		expect(readCommitted()).toBe("first\nA\tnew.md");
	});

	it("commits a directory holding only tracked files", () => {
		write("src/one.md");
		write("src/two.md");
		git("add", "src");
		git("commit", "-qm", "seed src");
		write("src/one.md", "edited\n");
		lands(["-m", "dir", "--", "src"]);
		expect(readCommitted()).toBe("dir\nM\tsrc/one.md");
	});

	it("takes a filename with a glob character literally", () => {
		write("n*.md");
		write("nope.md");
		lands(["-m", "star", "--", "n*.md"]);
		expect(readCommitted()).toBe("star\nA\tn*.md");
	});

	it("reads the message from a file and from stdin, backticks intact", () => {
		const msg = path.join(sb.dir, "msg.txt");
		fs.writeFileSync(msg, "from `file`\n\nbody line\n");
		write("one.md");
		lands(["-F", msg, "--", "one.md"]);
		expect(git("log", "-1", "--format=%B").trim()).toBe(
			"from `file`\n\nbody line",
		);
		write("two.md");
		lands(["-F", "-", "--", "two.md"], { stdin: "from `stdin`\n" });
		expect(git("log", "-1", "--format=%s").trim()).toBe("from `stdin`");
	});

	it("takes a message that is itself `--` as the message, not the separator", () => {
		write("new.md");
		lands(["-m", "--", "--", "new.md"]);
		expect(readCommitted()).toBe("--\nA\tnew.md");
	});

	it("runs the pre-commit hook on a passing commit", () => {
		const hook = path.join(hooks, "pre-commit");
		fs.writeFileSync(
			hook,
			`#!/bin/sh\ntouch ${shellQuote(path.join(sb.dir, "ran"))}\n`,
		);
		fs.chmodSync(hook, 0o755);
		write("new.md");
		lands(["-m", "x", "--", "new.md"]);
		expect(fs.existsSync(path.join(sb.dir, "ran"))).toBe(true);
	});

	it("works the same from a linked worktree", () => {
		const wt = path.join(sb.dir, "wt");
		git("worktree", "add", "-q", "-b", "side", wt);
		fs.writeFileSync(path.join(wt, "new.md"), "in the worktree\n");
		const r = run(["-m", "from wt", "--", "new.md"], { cwd: wt });
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/committed [0-9a-f]+ from wt\n/);
		expect(readCommitted("side")).toBe("from wt\nA\tnew.md");
		expect(readHead()).not.toBe(git("rev-parse", "side").trim());
	});
});

describe("a hook refusal — exit 3, intent-add left for a safe re-run", () => {
	it("passes the gate's output through, keeps the intent-add entry, and a re-run after the fix commits cleanly", () => {
		gate();
		write("gate-refuses");
		write("new.md");
		write("a.md", "edited\n");
		const tip = readHead();

		const refused = run(["-m", "gated", "--", "new.md", "a.md"]);
		expect(refused.status).toBe(3);
		expect(refused.stderr).toContain("gate: fix the widget");
		expect(refused.stderr).toMatch(/a hook refused the commit \(exit 1\)/);
		expect(refused.stderr).toMatch(
			/intent-add entries for new\.md are left in the index.*re-running the same command/s,
		);
		expect(readHead()).toBe(tip);
		expect(git("ls-files", "--", "new.md")).toBe("new.md\n");

		fs.rmSync(path.join(sb.repo, "gate-refuses"));
		const again = run(["-m", "gated", "--", "new.md", "a.md"]);
		expect(again.status).toBe(0);
		expect(readCommitted()).toBe("gated\nM\ta.md\nA\tnew.md");
		expect(git("status", "--porcelain")).toBe("");
	});
});

describe("--patch: some of a file's lines, the working tree never written (#801)", () => {
	/** a.md at HEAD reads `a`; the patch adds a line above it, and leaves out one below. */
	const split = () => {
		write("a.md", "mine\na\ntheirs\n");
		const diff = git("diff", "HEAD", "-U0", "--", "a.md");
		// The left-out line is the last hunk; cut it.
		const mine = diff.slice(0, diff.lastIndexOf("@@ -1,0"));
		fs.writeFileSync(path.join(sb.dir, "mine.patch"), mine);
		return path.join(sb.dir, "mine.patch");
	};
	const readBytes = (rel: string) => fs.readFileSync(path.join(sb.repo, rel));
	const readPrivates = () =>
		fs
			.readdirSync(path.join(sb.repo, ".git"))
			.filter((f) => f.startsWith("commit-paths-"));

	it("commits only the patch's hunk, leaves the other line in the working tree unwritten, and resets the index", () => {
		const patch = split();
		const file = path.join(sb.repo, "a.md");
		const mtime = fs.statSync(file).mtimeMs;
		const r = run(["-m", "mine", "--patch", patch]);
		expect(r.status).toBe(0);
		expect(git("show", "HEAD:a.md")).toBe("mine\na\n");
		expect(readBytes("a.md").toString()).toBe("mine\na\ntheirs\n");
		expect(fs.statSync(file).mtimeMs).toBe(mtime);
		expect(git("diff", "--cached", "--name-only")).toBe("");
		expect(git("diff", "-U0", "--", "a.md")).toMatch(/^\+theirs$/m);
		expect(r.stdout).toMatch(/ a\.md \| 1 \+/);
		expect(readPrivates()).toEqual([]);
	});

	it("lands a pure insertion at its old-side line where an earlier hunk was cut (#1659)", () => {
		const lines = (n: number) =>
			Array.from({ length: n }, (_, i) => `l${i + 1}`);
		write("a.md", `${lines(10).join("\n")}\n`);
		// b.md's deleted `-- sig` reads `--- sig` in the patch, like a file header.
		write("b.md", "b1\n-- sig\nb3\nb4\n");
		git("add", "b.md");
		git("commit", "-qam", "seed");
		const tree = lines(10);
		tree.splice(8, 0, "mine2");
		tree.splice(5, 0, "theirs1", "theirs2");
		tree.splice(3, 0, "mine1");
		write("a.md", `${tree.join("\n")}\n`);
		write("b.md", "b1\nb3\nmineb\nb4\n");
		const diff = git("diff", "HEAD", "-U0", "--", "a.md", "b.md");
		const theirs = /^@@ -5,0 \+7,2 @@.*\n\+theirs1\n\+theirs2\n/m;
		expect(diff).toMatch(theirs);
		expect(diff).toMatch(/^@@ -8,0 \+12 @@/m);
		const patch = path.join(sb.dir, "mine.patch");
		fs.writeFileSync(patch, diff.replace(theirs, ""));
		const r = run(["-m", "mine", "--patch", patch]);
		expect(r.status).toBe(0);
		const want = lines(10);
		want.splice(8, 0, "mine2");
		want.splice(3, 0, "mine1");
		expect(git("show", "HEAD:a.md")).toBe(`${want.join("\n")}\n`);
		expect(git("show", "HEAD:b.md")).toBe("b1\nb3\nmineb\nb4\n");
	});

	it("adds whole paths after `--`, a new one included, in the same commit", () => {
		const patch = split();
		write("new.md");
		write("other.md");
		const r = run(["-m", "both", "--patch", patch, "--", "new.md"]);
		expect(r.status).toBe(0);
		expect(readCommitted()).toBe("both\nM\ta.md\nA\tnew.md");
		expect(git("status", "--porcelain")).toBe(" M a.md\n?? other.md\n");
	});

	it("removes a whole path gone from disk that .gitignore now covers (#1960)", () => {
		const patch = split();
		write("types/t.d.ts");
		git("add", "types/t.d.ts");
		git("commit", "-qm", "seed types");
		fs.rmSync(path.join(sb.repo, "types"), { recursive: true });
		write(".gitignore", "types/\n");
		const r = run([
			"-m",
			"untrack",
			"--patch",
			patch,
			"--",
			"types/t.d.ts",
			".gitignore",
		]);
		expect(r.status).toBe(0);
		expect(readCommitted()).toBe(
			"untrack\nA\t.gitignore\nM\ta.md\nD\ttypes/t.d.ts",
		);
	});

	it("keeps a tracked symlink whose target is gone, which is still on disk", () => {
		const patch = split();
		fs.symlinkSync("target.md", path.join(sb.repo, "link.md"));
		git("add", "link.md");
		git("commit", "-qm", "seed link");
		fs.rmSync(path.join(sb.repo, "link.md"));
		fs.symlinkSync("elsewhere.md", path.join(sb.repo, "link.md"));
		const r = run(["-m", "repoint", "--patch", patch, "--", "link.md"]);
		expect(r.status).toBe(0);
		expect(readCommitted()).toBe("repoint\nM\ta.md\nM\tlink.md");
	});

	it("reads the patch's repo-root paths from a subdirectory", () => {
		write("src/b.md", "b\n");
		git("add", "src/b.md");
		git("commit", "-qm", "seed src");
		write("src/b.md", "b\nmine\n");
		fs.writeFileSync(
			path.join(sb.dir, "b.patch"),
			git("diff", "HEAD", "-U0", "--", "src/b.md"),
		);
		const r = run(["-m", "sub", "--patch", path.join(sb.dir, "b.patch")], {
			cwd: path.join(sb.repo, "src"),
		});
		expect(r.status).toBe(0);
		expect(readCommitted()).toBe("sub\nM\tsrc/b.md");
	});

	it("refuses a re-run once the patch has landed, naming the file and leaving HEAD and the index as they were, rather than adding its lines twice", () => {
		const patch = split();
		expect(run(["-m", "mine", "--patch", patch]).status).toBe(0);
		const tip = readHead();
		const before = readIndex();
		const r = run(["-m", "mine", "--patch", patch]);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(
			/not cut against HEAD for a\.md.*already committed it, it is done/s,
		);
		expect(readHead()).toBe(tip);
		expect(readIndex()).toBe(before);
		expect(readPrivates()).toEqual([]);
	});

	const WayOut =
		/would show the commit reversed\. Cut the patch from `git diff HEAD -U0 -- <path>` \(`--binary` for a binary file\) in the tree you commit from\. Nothing written/;
	/** Runs `args`, expecting a refusal naming `why`, and nothing written. */
	const expectNotInTree = (why: RegExp, ...runs: string[][]) => {
		const tip = readHead();
		const before = readIndex();
		for (const args of runs) {
			const r = run(args);
			expect(r.status).toBe(2);
			expect(r.stderr).toMatch(why);
			expect(r.stderr).toMatch(WayOut);
		}
		expect(readHead()).toBe(tip);
		expect(readIndex()).toBe(before);
	};
	const cut = (name: string, ...args: string[]) => {
		const patch = path.join(sb.dir, name);
		fs.writeFileSync(patch, git("diff", "HEAD", ...args));
		return patch;
	};
	const commits = (patch: string) =>
		expect(run(["-m", "x", "--patch", patch]).status).toBe(0);

	it("refuses a patch whose added lines this tree's files lack, as one cut in another worktree, naming each such file (#4338)", () => {
		write("b.md", "b\n");
		git("add", "b.md");
		git("commit", "-qm", "seed b");
		const patch = split();
		write("b.md", "b\nmine b\n");
		fs.appendFileSync(patch, git("diff", "HEAD", "-U0", "--", "b.md"));
		git("checkout", "--", "a.md", "b.md");
		expectNotInTree(
			/lines, modes or contents are not in this tree's files for a\.md \(lacks the lines of hunk \+1\); b\.md \(lacks the lines of hunk \+2\)\./,
			["-m", "x", "--patch", patch],
			["--tree", "--patch", patch],
		);
	});

	it("commits a patch cut from a CRLF checkout, whose diff git prints in LF (#4338)", () => {
		git("config", "core.autocrlf", "true");
		const patch = split();
		write("a.md", "mine\r\na\r\ntheirs\r\n");
		const r = run(["-m", "mine", "--patch", patch]);
		expect(r.status).toBe(0);
		expect(git("show", "HEAD:a.md")).toBe("mine\na\n");
	});

	it("refuses a patch deleting a file this tree still holds (#4338)", () => {
		write("b.md", "b\n");
		git("add", "b.md");
		git("commit", "-qm", "seed b");
		fs.rmSync(path.join(sb.repo, "b.md"));
		const patch = cut("rm.patch", "-U0", "--", "b.md");
		git("checkout", "--", "b.md");
		expectNotInTree(/for b\.md \(deleted, still on disk\)\./, [
			"-m",
			"rm",
			"--patch",
			patch,
		]);
	});

	it("refuses a mode change this tree's file does not have, and commits one it has (#4339)", () => {
		const file = path.join(sb.repo, "a.md");
		fs.chmodSync(file, 0o755);
		const patch = cut("mode.patch", "-U0", "--", "a.md");
		expect(fs.readFileSync(patch, "utf8")).toMatch(/^new mode 100755$/m);
		fs.chmodSync(file, 0o644);
		expectNotInTree(/for a\.md \(mode 100644, the patch gives 100755\)/, [
			"-m",
			"x",
			"--patch",
			patch,
		]);
		fs.chmodSync(file, 0o755);
		commits(patch);
		expect(git("ls-tree", "HEAD", "a.md")).toMatch(/^100755 /);
	});

	it("commits an executable-bit change where the checkout tracks no executable bit (#4339)", () => {
		const file = path.join(sb.repo, "a.md");
		fs.chmodSync(file, 0o755);
		const patch = cut("mode.patch", "-U0", "--", "a.md");
		fs.chmodSync(file, 0o644);
		git("config", "core.fileMode", "false");
		commits(patch);
		expect(git("ls-tree", "HEAD", "a.md")).toMatch(/^100755 /);
	});

	it("judges a file-to-symlink typechange by the link, not its delete (#4339)", () => {
		const file = path.join(sb.repo, "a.md");
		fs.rmSync(file);
		fs.symlinkSync("target", file);
		const patch = cut("link.patch", "-U0", "--", "a.md");
		expect(fs.readFileSync(patch, "utf8")).toMatch(/^new file mode 120000$/m);
		fs.rmSync(file);
		git("checkout", "--", "a.md");
		expectNotInTree(/for a\.md \(mode 100644, the patch gives 120000\)/, [
			"-m",
			"x",
			"--patch",
			patch,
		]);
		fs.rmSync(file);
		fs.symlinkSync("target", file);
		commits(patch);
		expect(git("ls-tree", "HEAD", "a.md")).toMatch(/^120000 /);
	});

	it("refuses a binary patch whose new blob this tree's file does not hold, and commits one it holds (#4339)", () => {
		const bin = path.join(sb.repo, "b.bin");
		fs.writeFileSync(bin, Buffer.from([0, 1, 2, 255]));
		git("add", "b.bin");
		git("commit", "-qm", "seed bin");
		fs.writeFileSync(bin, Buffer.from([0, 9, 9, 255]));
		const patch = cut("bin.patch", "--binary", "--", "b.bin");
		const post = git("hash-object", "b.bin").trim();
		git("checkout", "--", "b.bin");
		expectNotInTree(
			new RegExp(`for b\\.bin \\(blob [0-9a-f]+, the patch gives ${post}\\)`),
			["-m", "x", "--patch", patch],
		);
		fs.writeFileSync(bin, Buffer.from([0, 9, 9, 255]));
		commits(patch);
		expect(git("rev-parse", "HEAD:b.bin").trim()).toBe(post);
	});

	it("commits a submodule hunk matching the submodule's HEAD, refuses one that does not, and passes an uninitialised submodule (#4339)", () => {
		const sub = path.join(sb.repo, "sub");
		const subGit = (...args: string[]) =>
			execFileSync(
				"git",
				["-c", "user.name=t", "-c", "user.email=t@t", ...args],
				{ cwd: sub, encoding: "utf8" },
			).trim();
		fs.mkdirSync(sub);
		subGit("init", "-q");
		subGit("commit", "-q", "--allow-empty", "-m", "one");
		const old = subGit("rev-parse", "HEAD");
		git("add", "sub");
		git("commit", "-qm", "seed sub");
		subGit("commit", "-q", "--allow-empty", "-m", "two");
		const next = subGit("rev-parse", "HEAD");
		const patch = cut("sub.patch", "-U0", "--", "sub");
		subGit("checkout", "-q", old);
		expectNotInTree(/for sub \(lacks the lines of hunk \+1\)/, [
			"-m",
			"x",
			"--patch",
			patch,
		]);
		subGit("checkout", "-q", next);
		commits(patch);
		expect(git("rev-parse", "HEAD:sub").trim()).toBe(next);
		// Uninitialised: an empty directory, where rev-parse would find the superproject.
		subGit("commit", "-q", "--allow-empty", "-m", "three");
		const third = subGit("rev-parse", "HEAD");
		const bump = cut("bump.patch", "-U0", "--", "sub");
		fs.rmSync(sub, { recursive: true });
		fs.mkdirSync(sub);
		commits(bump);
		expect(git("rev-parse", "HEAD:sub").trim()).toBe(third);
	});

	it("refuses a file both in the patch and named whole, and a patch that does not apply, writing neither index", () => {
		const patch = split();
		const tip = readHead();
		const before = readIndex();
		let r = run(["-m", "x", "--patch", patch, "--", "a.md"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(
			/a\.md is in the patch and also named whole.*Leave it to the patch/s,
		);
		// No `index` line, so the preimage check stands aside and git apply judges it.
		const bare = path.join(sb.dir, "bare.patch");
		fs.writeFileSync(
			bare,
			"diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1 +0,0 @@\n-not in HEAD\n",
		);
		r = run(["-m", "x", "--patch", bare]);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(
			/the patch does not apply to HEAD.*Cut it from `git diff HEAD -U0/s,
		);
		expect(readHead()).toBe(tip);
		expect(readIndex()).toBe(before);
		expect(readPrivates()).toEqual([]);
	});

	it("refuses `.` from a subdirectory, a whole path holding a patched file, naming that file and leaving the index as it was", () => {
		write("src/b.md", "b\n");
		git("add", "src/b.md");
		git("commit", "-qm", "seed src");
		write("src/b.md", "mine\nb\n");
		const patch = path.join(sb.dir, "b.patch");
		fs.writeFileSync(patch, git("diff", "HEAD", "-U0", "--", "src/b.md"));
		const before = readIndex();
		const r = run(["-m", "x", "--patch", patch, "--", "."], {
			cwd: path.join(sb.repo, "src"),
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/src\/b\.md is in the patch and also named whole/);
		expect(readIndex()).toBe(before);
	});

	it("commits a rename, resetting both its sides in the index", () => {
		git("mv", "a.md", "moved.md");
		const patch = path.join(sb.dir, "mv.patch");
		fs.writeFileSync(patch, git("diff", "--cached", "-M", "HEAD"));
		git("reset", "-q");
		const r = run(["-m", "move", "--patch", patch]);
		expect(r.status).toBe(0);
		expect(readCommitted()).toBe("move\nR100\ta.md\tmoved.md");
		expect(git("diff", "--cached", "--name-only")).toBe("");
	});

	it("unstages a staged copy of a patched file, which stays in the working tree", () => {
		const patch = split();
		write("a.md", "staged\n");
		git("add", "a.md");
		write("a.md", "mine\na\ntheirs\n");
		const r = run(["-m", "mine", "--patch", patch]);
		expect(r.status).toBe(0);
		expect(r.stderr).not.toMatch(/staged/);
		expect(git("diff", "--cached", "--name-only")).toBe("");
		expect(readBytes("a.md").toString()).toBe("mine\na\ntheirs\n");
	});

	it("commits a new file intent-added to cut its diff, reading its empty index entry as no staged copy (#3959)", () => {
		write("new.md", "fresh\n");
		git("add", "-N", "--", "new.md");
		const patch = path.join(sb.dir, "new.patch");
		fs.writeFileSync(patch, git("diff", "--", "new.md"));
		const r = run(["-m", "add new", "--patch", patch]);
		expect(r.status).toBe(0);
		expect(r.stderr).not.toMatch(/staged/);
		expect(readCommitted()).toBe("add new\nA\tnew.md");
		expect(git("show", "HEAD:new.md")).toBe("fresh\n");
		expect(git("status", "--porcelain", "--", "new.md")).toBe("");
	});

	it("exits 4 where the commit landed but the index stayed locked, giving the reset to run, saying never to re-run, and still running post-commit", () => {
		const hook = path.join(hooks, "commit-msg");
		fs.writeFileSync(hook, "#!/bin/sh\ntouch .git/index.lock\n");
		fs.chmodSync(hook, 0o755);
		const after = path.join(hooks, "post-commit");
		fs.writeFileSync(after, "#!/bin/sh\necho post-commit ran >&2\n");
		fs.chmodSync(after, 0o755);
		const r = run(["-m", "mine", "--patch", split()]);
		expect(r.status).toBe(4);
		expect(git("show", "HEAD:a.md")).toBe("mine\na\n");
		expect(r.stderr).toMatch(
			/Do not re-run this command: the commit has landed.*git reset -q -- ':\(top,literal\)a\.md'/s,
		);
		expect(r.stderr).toContain("post-commit ran");
		fs.rmSync(path.join(sb.repo, ".git", "index.lock"));
	});

	it("refuses --patch given twice, leaving the index as it was", () => {
		const patch = split();
		const before = readIndex();
		const r = run(["-m", "x", "--patch", patch, "--patch", patch]);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/give --patch once/);
		expect(readIndex()).toBe(before);
	});

	it("runs the hooks against the private index, and a refusal touches neither the index nor the tree, leaves no private index and says a re-run is safe", () => {
		const hook = path.join(hooks, "pre-commit");
		fs.writeFileSync(
			hook,
			'#!/bin/sh\necho "index=$GIT_INDEX_FILE" >&2\nif [ -f gate-refuses ]; then echo "gate: fix the widget" >&2; exit 1; fi\n',
		);
		fs.chmodSync(hook, 0o755);
		const patch = split();
		write("gate-refuses");
		const before = readIndex();
		const tip = readHead();
		const refused = run(["-m", "gated", "--patch", patch]);
		expect(refused.status).toBe(3);
		expect(refused.stderr).toMatch(/index=.*\.git\/commit-paths-\d+\.index/);
		expect(refused.stderr).toMatch(
			/re-running the same command after the fix is safe/,
		);
		expect(readHead()).toBe(tip);
		expect(readIndex()).toBe(before);
		expect(readBytes("a.md").toString()).toBe("mine\na\ntheirs\n");
		expect(readPrivates()).toEqual([]);

		fs.rmSync(path.join(sb.repo, "gate-refuses"));
		expect(run(["-m", "gated", "--patch", patch]).status).toBe(0);
		expect(git("show", "HEAD:a.md")).toBe("mine\na\n");
	});

	const hookScript = (name: string, body: string) => {
		const hook = path.join(hooks, name);
		fs.writeFileSync(hook, `#!/bin/sh\n${body}\n`);
		fs.chmodSync(hook, 0o755);
	};

	it("keeps its own message while another commit writes COMMIT_EDITMSG under its hooks (#2638)", () => {
		hookScript(
			"commit-msg",
			'echo "other message" > "$(git rev-parse --git-dir)/COMMIT_EDITMSG"',
		);
		const r = run(["-m", "mine", "--patch", split()]);
		expect(r.status).toBe(0);
		expect(readCommitted()).toBe("mine\nM\ta.md");
		expect(readPrivates()).toEqual([]);
	});

	it("hands prepare-commit-msg and commit-msg the message file as git does, committing what they leave in it", () => {
		hookScript("prepare-commit-msg", 'printf "\\nsource=%s\\n" "$2" >> "$1"');
		hookScript("commit-msg", 'printf "checked  \\n\\n\\n" >> "$1"');
		const r = run(["-m", "mine", "--patch", split()]);
		expect(r.status).toBe(0);
		expect(git("log", "-1", "--format=%B")).toBe(
			"mine\n\nsource=message\nchecked\n\n",
		);
		expect(git("reflog", "-1", "--format=%gs")).toBe("commit: mine\n");
	});

	it("refuses a message the hooks leave empty, nothing written", () => {
		hookScript("commit-msg", ': > "$1"');
		const tip = readHead();
		const r = run(["-m", "mine", "--patch", split()]);
		expect(r.status).toBe(3);
		expect(r.stderr).toMatch(
			/the prepare-commit-msg or commit-msg hook left the message empty.*Read what that hook printed above\. Nothing written\./,
		);
		expect(readHead()).toBe(tip);
	});

	it("refuses a pre-commit that leaves the index matching HEAD, nothing written", () => {
		hookScript("pre-commit", "git read-tree HEAD");
		const tip = readHead();
		const r = run(["-m", "mine", "--patch", split()]);
		expect(r.status).toBe(3);
		expect(r.stderr).toMatch(
			/pre-commit hook left the index matching HEAD, so there is nothing to commit\. Read what the hook printed above/,
		);
		expect(readHead()).toBe(tip);
	});

	it("strips comment lines where commit.cleanup is strip, as git commit -m does", () => {
		git("config", "commit.cleanup", "strip");
		hookScript("commit-msg", 'echo "# a comment" >> "$1"');
		expect(run(["-m", "mine", "--patch", split()]).status).toBe(0);
		expect(git("log", "-1", "--format=%B")).toBe("mine\n\n");
	});

	it("signs where commit.gpgSign is set, refusing as git commit does when signing fails", () => {
		git("config", "commit.gpgSign", "true");
		git("config", "gpg.program", "false");
		const tip = readHead();
		const r = run(["-m", "mine", "--patch", split()]);
		expect(r.status).toBe(3);
		expect(r.stderr).toMatch(/git or a hook refused the commit/);
		expect(readHead()).toBe(tip);
	});

	it("refuses while a merge is in progress, nothing written", () => {
		fs.writeFileSync(
			path.join(sb.repo, ".git", "MERGE_HEAD"),
			`${readHead()}\n`,
		);
		const before = readIndex();
		const r = run(["-m", "mine", "--patch", split()]);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(
			/MERGE_HEAD is set: a merge, cherry-pick or revert is in progress.*Finish or abort it first\. Nothing written\./,
		);
		expect(readIndex()).toBe(before);
	});

	it("refuses, exit 3, where another commit moves HEAD while the hooks run, the ref update naming the HEAD the index was built on", () => {
		write("held.md");
		git("add", "held.md");
		git("commit", "-qm", "seed held");
		hookScript(
			"pre-commit",
			[
				`export GIT_INDEX_FILE=${shellQuote(path.join(sb.dir, "other.index"))}`,
				"git read-tree HEAD",
				'git update-index --add --cacheinfo "100644,$(echo edited | git hash-object -w --stdin),held.md"',
				'git update-ref HEAD "$(git commit-tree "$(git write-tree)" -p HEAD -m other)"',
			].join("\n"),
		);
		const r = run(["-m", "mine", "--patch", split()]);
		expect(r.status).toBe(3);
		expect(r.stderr).toMatch(/cannot lock ref 'HEAD'/);
		expect(r.stderr).toContain("git or a hook refused the commit (exit");
		expect(r.stderr).toContain(
			"re-running the same command after the fix is safe",
		);
		expect(readCommitted()).toBe("other\nM\theld.md");
		expect(readPrivates()).toEqual([]);
		expect(readLastOutcome()?.[1]).toBe("git-refused");
	});
});

describe("an adopter's plugin copy", () => {
	it("runs as an adopter's plugin copy with Node alone, no node_modules anywhere above it (#587)", () => {
		const plugin = path.join(sb.dir, "plugin", "scripts");
		installLib(path.join(plugin, "lib"), {
			keep: (f) => /\.(js|json)$/.test(f),
		});
		fs.copyFileSync(
			path.join(__dirname, "commit-paths.js"),
			path.join(plugin, "commit-paths.js"),
		);
		for (let d = plugin; d !== path.dirname(d); d = path.dirname(d))
			expect(fs.existsSync(path.join(d, "node_modules"))).toBe(false);

		write("a.md", "edited\n");
		const { NODE_PATH: _, ...env } = process.env;
		const r = spawnSync(
			"node",
			[path.join(plugin, "commit-paths.js"), "-m", "plugin", "--", "a.md"],
			{ cwd: sb.repo, env, encoding: "utf8" },
		);
		expect(r.stderr).not.toContain("Cannot find module");
		expect(r.status).toBe(0);
		expect(readCommitted()).toBe("plugin\nM\ta.md");
	});
});

describe("post-commit's claim release after a commit-paths commit (#3254)", () => {
	// Three files, one on the detect-only scripts/ tier.
	const held = ["a.md", "scripts/lib/one.js", "notes.md"];

	// The fixture's post-commit: the real hook's release block, calling the real arbiter.
	beforeEach(() => {
		const hook = path.join(hooks, "post-commit");
		fs.writeFileSync(
			hook,
			`#!/bin/sh\nset -e\nWFC_PLUGIN_ROOT=${shellQuote(ROOT)}\n${cutPostCommitBlock("release_committed_claims")}\nrelease_committed_claims\n`,
		);
		fs.chmodSync(hook, 0o755);
	});

	const commitHeld = () => {
		const alice = live(sb, "alice");
		for (const rel of held) {
			store.acquire(rel, alice);
			write(rel, "alice's edit\n");
		}
		return runWith(["-m", "mine", "--", ...held], {
			...process.env,
			CLAUDE_CODE_SESSION_ID: "alice",
		});
	};

	/** git hands a hook's stdout to its own stderr. */
	const expectReleased = (r: { status: number | null; stderr: string }) => {
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(/^Released .* — the commit holding/m);
		for (const rel of held) expect(r.stderr).toContain(rel);
		expect(store.listLocks()).toEqual([]);
	};

	it("drops every claim once every hunk the session held has landed", () => {
		expectReleased(commitHeld());
	});

	// The hook ran while the index still held the old copies, which read as
	// still uncommitted (#3565).
	it.each([
		["written from Bash before its claim", true],
		["claimed after its first write", false],
	])("drops them after a --patch commit of files %s", (_, observedFirst) => {
		const alice = live(sb, "alice");
		for (const rel of held) {
			write(rel, "alice's edit\n");
			if (observedFirst) store.recordObservation(rel, alice, { viaBash: true });
			store.acquire(rel, alice);
		}
		git("add", "-N", "--", ...held);
		const patch = path.join(sb.dir, "mine.patch");
		fs.writeFileSync(patch, git("diff", "--", ...held));
		git("reset", "-q", "--", ...held);
		expectReleased(
			runWith(["-m", "mine", "--patch", patch], {
				...process.env,
				CLAUDE_CODE_SESSION_ID: "alice",
			}),
		);
	});

	it.each([
		["HEAD^", "a stopped range left"],
		["HEAD", "a single pick rewrote"],
	])(
		"drops them over a leftover .git/sequencer whose abort-safety names %s, as %s (#3298)",
		(rev) => {
			write("b.md");
			git("add", "b.md");
			git("commit", "-qm", "seed b");
			plantSequencer(sb.repo, rev);
			expectReleased(commitHeld());
		},
	);
});

describe("git's own refusals — exit 3, relayed", () => {
	it("passes a held index.lock through, leaving the lock in place", () => {
		write("a.md", "edited\n");
		const tip = readHead();
		const lock = path.join(sb.repo, ".git", "index.lock");
		fs.writeFileSync(lock, "");
		let r: ReturnType<typeof run>;
		try {
			r = run(["-m", "x", "--", "a.md"]);
			expect(fs.existsSync(lock)).toBe(true);
		} finally {
			fs.rmSync(lock);
		}
		expect(r.status).toBe(3);
		expect(r.stderr).toMatch(/index\.lock': File exists\./);
		expect(r.stderr).toContain("git or a hook refused the commit (exit 128)");
		expect(readHead()).toBe(tip);
		expect(readLastOutcome()?.slice(1)).toEqual(["git-refused", "0.0"]);
	});

	it("passes a refusal of the intent-add through, saying nothing was intent-added", () => {
		write("new.md");
		const before = readIndex();
		const dotGit = path.join(sb.repo, ".git");
		fs.chmodSync(dotGit, 0o555);
		let r: ReturnType<typeof run>;
		try {
			r = run(["-m", "x", "--", "new.md"]);
		} finally {
			fs.chmodSync(dotGit, 0o755);
		}
		expect(r.status).toBe(3);
		expect(r.stderr).toContain("Permission denied");
		expect(r.stderr).toMatch(/nothing was intent-added\. Re-run once/);
		expect(r.stderr).not.toContain("left in the index");
		expect(readIndex()).toBe(before);
		expect(readLastOutcome()?.slice(1)).toEqual(["git-refused", "0.0"]);
	});

	it("passes a stale HEAD.lock through, relaying the git error", () => {
		write("a.md", "edited\n");
		const tip = readHead();
		const headLock = path.join(sb.repo, ".git", "HEAD.lock");
		fs.writeFileSync(headLock, "");
		let r: ReturnType<typeof run>;
		try {
			r = run(["-m", "x", "--", "a.md"]);
		} finally {
			fs.rmSync(headLock);
		}
		expect(r.status).toBe(3);
		expect(r.stderr).toMatch(
			/fatal: cannot lock ref 'HEAD': Unable to create '.*HEAD\.lock': File exists\./,
		);
		expect(r.stderr).toContain("git or a hook refused the commit (exit 128)");
		expect(readHead()).toBe(tip);
		expect(readLastOutcome()?.slice(1)).toEqual(["git-refused", "0.0"]);
	});

	it("logs a commit's outcome and its pre-lock seconds", () => {
		write("new.md");
		expect(run(["-m", "x", "--", "new.md"]).status).toBe(0);
		expect(readLastOutcome()?.slice(1)).toEqual(["committed", "0.0"]);
	});
});

const readLog = () => {
	const read = readText(store.paths.commitPathsLog());
	if (read.state === "unreadable") throw read.error;
	return read.state === "read" ? read.data : "";
};

describe("--tree: the tree the commit would carry, nothing written (#1695)", () => {
	/** The tree printed, asserting the index, the working tree and the log untouched. */
	const tree = (args: string[]) => {
		const before = [readIndex(), git("status", "--porcelain"), readLog()];
		const r = run(["--tree", ...args]);
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		expect([readIndex(), git("status", "--porcelain"), readLog()]).toEqual(
			before,
		);
		expect(
			fs
				.readdirSync(path.join(sb.repo, ".git"))
				.filter((f) => f.startsWith("commit-paths-")),
		).toEqual([]);
		return r.stdout.trim();
	};

	it("prints the tree a plain commit then carries — an edit, a new file and a deletion — whatever else the index holds", () => {
		write("gone.md");
		write("staged.md", "old\n");
		git("add", "gone.md", "staged.md");
		git("commit", "-qm", "seed");
		write("staged.md", "a staged copy\n");
		git("add", "staged.md");
		write("a.md", "a\nmine\n");
		write("new.md");
		fs.rmSync(path.join(sb.repo, "gone.md"));
		const printed = tree(["--", "a.md", "new.md", "gone.md"]);
		expect(run(["-m", "x", "--", "a.md", "new.md", "gone.md"]).status).toBe(0);
		expect(git("rev-parse", "HEAD^{tree}").trim()).toBe(printed);
	});

	it("prints the tree a --patch commit then carries, a whole path included", () => {
		write("a.md", "mine\na\ntheirs\n");
		const diff = git("diff", "HEAD", "-U0", "--", "a.md");
		const patch = path.join(sb.dir, "mine.patch");
		fs.writeFileSync(patch, diff.slice(0, diff.lastIndexOf("@@ -1,0")));
		write("new.md");
		const printed = tree(["--patch", patch, "--", "new.md"]);
		expect(run(["-m", "x", "--patch", patch, "--", "new.md"]).status).toBe(0);
		expect(git("rev-parse", "HEAD^{tree}").trim()).toBe(printed);
		expect(git("show", "HEAD:a.md")).toBe("mine\na\n");
	});

	it("prints HEAD's tree for paths that all match HEAD (#4288)", () => {
		expect(tree(["--", "a.md"])).toBe(git("rev-parse", "HEAD^{tree}").trim());
	});

	it("prints HEAD's tree for a patch that leaves HEAD as it is (#4288)", () => {
		const blob = git("rev-parse", "HEAD:a.md").trim();
		const patch = path.join(sb.dir, "noop.patch");
		fs.writeFileSync(
			patch,
			`diff --git a/a.md b/a.md\nindex ${blob}..${blob} 100644\n--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@\n-a\n+a\n`,
		);
		expect(tree(["--patch", patch])).toBe(
			git("rev-parse", "HEAD^{tree}").trim(),
		);
		const r = run(["-m", "x", "--patch", patch]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("leave HEAD as it is");
	});

	it.each([
		["a message", ["-m", "x", "--", "a.md"], "takes no message"],
		["no paths", [], "no paths after `--`"],
	])("refuses %s, logging no outcome", (_, args, why) => {
		const before = readLog();
		const r = run(["--tree", ...args]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(why);
		expect(r.stdout).toBe("");
		expect(readLog()).toBe(before);
	});

	it("prints HEAD's tree for a patch already committed — an edit and a deletion, a whole path beside it — where the commit refuses (#4700)", () => {
		write("gone.md");
		git("add", "gone.md");
		git("commit", "-qm", "seed");
		write("a.md", "mine\na\n");
		fs.rmSync(path.join(sb.repo, "gone.md"));
		write("whole.md");
		const patch = path.join(sb.dir, "mine.patch");
		fs.writeFileSync(
			patch,
			git("diff", "HEAD", "-U0", "--", "a.md", "gone.md"),
		);
		expect(run(["-m", "x", "--patch", patch, "--", "whole.md"]).status).toBe(0);
		expect(tree(["--patch", patch, "--", "whole.md"])).toBe(
			git("rev-parse", "HEAD^{tree}").trim(),
		);
		const r = run(["-m", "x", "--patch", patch]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("was not cut against HEAD for a.md");
	});

	it.each([
		[
			"a new file",
			() => {
				write("new.md");
				git("add", "-N", "new.md");
				return git("diff", "HEAD", "-U0", "--", "new.md");
			},
		],
		[
			"a pure rename",
			() => {
				git("mv", "a.md", "moved.md");
				return git("diff", "--cached", "-M", "HEAD", "--", "a.md", "moved.md");
			},
		],
	])(
		"prints HEAD's tree for %s already committed, which no preimage marks stale (#4700)",
		(_, cut) => {
			fs.writeFileSync(path.join(sb.dir, "mine.patch"), cut());
			git("add", "-A");
			git("commit", "-qm", "x");
			expect(tree(["--patch", path.join(sb.dir, "mine.patch")])).toBe(
				git("rev-parse", "HEAD^{tree}").trim(),
			);
		},
	);

	it.each([
		[
			"cut against neither HEAD nor its commit",
			() => {
				write("a.md", "other\n");
				git("commit", "-qam", "other");
			},
		],
		[
			"committed for only some of its files",
			() => git("commit", "-qm", "part", "--", "a.md"),
		],
	])("refuses a patch %s, naming the file and the re-cut", (_, land) => {
		write("b.md");
		git("add", "b.md");
		git("commit", "-qm", "seed");
		write("a.md", "mine\na\n");
		write("b.md", "mine\nb.md\n");
		const patch = path.join(sb.dir, "mine.patch");
		fs.writeFileSync(patch, git("diff", "HEAD", "-U0", "--", "a.md", "b.md"));
		land();
		write("a.md", "mine\na\n");
		const r = run(["--tree", "--patch", patch]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("was not cut against HEAD for a.md");
		expect(r.stderr).toContain("git diff HEAD -U0 -- <path>");
	});
});

describe("--check: the verdict a commit would get, nothing written (#4207)", () => {
	const runs = () => path.join(sb.dir, "pre-commit-runs");
	const countRuns = () => {
		const read = readText(runs());
		if (read.state === "unreadable") throw read.error;
		return read.state === "read"
			? read.data.split("\n").filter(Boolean).length
			: 0;
	};
	const gitDir = () => path.join(sb.repo, ".git");
	const Sid = "check-session";
	const reviewStamp = () => path.join(gitDir(), `wfc-review-tier-${Sid}`);
	const hookScript = (name: string, body: string) => {
		const hook = path.join(hooks, name);
		fs.writeFileSync(hook, `#!/bin/sh\n${body}\n`);
		fs.chmodSync(hook, 0o755);
	};
	/** pre-commit as the real stack ends: a gate, then the review hold's and the stand-down stamp, each keyed to the tree. */
	beforeEach(() => {
		hookScript(
			"pre-commit",
			[
				`echo "index=$GIT_INDEX_FILE" >> ${shellQuote(runs())}`,
				'if [ -f gate-refuses ]; then echo "lint: a.md:1 unused widget" >&2; exit 1; fi',
				'd="$(git rev-parse --absolute-git-dir)"',
				`printf '%s\\nunheld\\n' "$(git write-tree)" > "$d/wfc-review-tier-${Sid}"`,
				'git write-tree > "$d/wfc-precommit-stamp"',
			].join("\n"),
		);
		hookScript(
			"commit-msg",
			`bash ${shellQuote(path.join(ROOT, "scripts/check-commit-subject.sh"))} "$1" commit-msg`,
		);
	});
	const check = (args: string[]) =>
		runWith(["--check", ...args], {
			...process.env,
			CLAUDE_CODE_SESSION_ID: Sid,
		});
	/** Everything a check may not move. */
	const snapshot = () => [
		readLog(),
		git("log", "--format=%H"),
		git("status", "--porcelain"),
		readIndex(),
		fs.readdirSync(gitDir()).sort(),
	];

	it("exits 3 on a gate's finding, printing it, and moves nothing", () => {
		write("a.md", "edited\n");
		write("gate-refuses");
		const before = snapshot();
		const r = check(["--", "a.md"]);
		expect(r.status).toBe(3);
		expect(r.stderr).toContain("lint: a.md:1 unused widget");
		expect(r.stderr).toMatch(/a commit of these paths would be refused/);
		expect(snapshot()).toEqual(before);
	});

	it("exits 0 on clean paths, a new file included, leaving no stamp, so the real commit runs its gates again", () => {
		write("a.md", "edited\n");
		write("new.md");
		const before = snapshot();
		const r = check(["--", "a.md", "new.md"]);
		expect(r.stderr).toContain("message checks");
		expect(r.stdout).toContain(
			"every gate a commit of these paths would run passed",
		);
		expect(r.status).toBe(0);
		expect(snapshot()).toEqual(before);
		expect(fs.existsSync(path.join(gitDir(), "wfc-precommit-stamp"))).toBe(
			false,
		);
		expect(fs.existsSync(reviewStamp())).toBe(false);
		expect(countRuns()).toBe(1);

		expect(run(["-m", "real", "--", "a.md", "new.md"]).status).toBe(0);
		expect(countRuns()).toBe(2);
	});

	it("keeps a stamp holding another tree, a neighbour commit's", () => {
		write("a.md", "edited\n");
		const stamp = path.join(gitDir(), "wfc-precommit-stamp");
		hookScript("pre-commit", `echo neighbour > ${shellQuote(stamp)}`);
		expect(check(["--", "a.md"]).status).toBe(0);
		expect(fs.readFileSync(stamp, "utf8")).toBe("neighbour\n");
	});

	it("fails a 73-character subject on the message checks, and passes a short one", () => {
		write("a.md", "edited\n");
		const long = check(["-m", "x".repeat(73), "--", "a.md"]);
		expect(long.status).toBe(3);
		expect(long.stderr).toMatch(/72/);
		const short = check(["-m", "a short subject", "--", "a.md"]);
		expect(short.stderr).not.toContain("message checks");
		expect(short.status).toBe(0);
		expect(git("log", "--format=%s", "-1")).not.toContain("a short subject");
	});

	it("judges a --patch's index, not the whole file", () => {
		hookScript(
			"pre-commit",
			'if git show :a.md | grep -q theirs; then echo "gate: theirs is in" >&2; exit 1; fi',
		);
		write("a.md", "mine\na\ntheirs\n");
		const diff = git("diff", "HEAD", "-U0", "--", "a.md");
		const patch = path.join(sb.dir, "mine.patch");
		fs.writeFileSync(patch, diff.slice(0, diff.lastIndexOf("@@ -1,0")));
		const before = snapshot();
		expect(check(["--patch", patch]).status).toBe(0);
		expect(check(["--", "a.md"]).status).toBe(3);
		expect(snapshot()).toEqual(before);
	});

	const patchOf = (text: string) => {
		write("a.md", text);
		const patch = path.join(sb.dir, "check.patch");
		fs.writeFileSync(patch, git("diff", "HEAD", "-U0", "--", "a.md"));
		git("checkout", "--", "a.md");
		return patch;
	};

	it.each<[string, () => string[], string]>([
		["--tree with it", () => ["--tree", "--", "a.md"], "not both"],
		["no change", () => ["--", "a.md"], "nothing to commit"],
		["an unknown path", () => ["--", "nowhere.md"], "exists nowhere"],
		[
			"a patch that does not apply",
			() => {
				// No `index` line, so git apply, not the preimage check, judges it.
				const patch = path.join(sb.dir, "bare.patch");
				fs.writeFileSync(
					patch,
					"diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1 +0,0 @@\n-not in HEAD\n",
				);
				return ["--patch", patch];
			},
			"the patch does not apply to HEAD",
		],
		[
			"a patch not cut against HEAD",
			() => {
				const patch = patchOf("a\nmine\n");
				write("a.md", "moved\n");
				git("commit", "-qm", "move", "--", "a.md");
				write("a.md", "moved\nmine\n");
				return ["--patch", patch];
			},
			"was not cut against HEAD",
		],
	])("refuses %s, exit 2, logging no outcome", (_, args, why) => {
		const given = args();
		const before = readLog();
		const r = check(given);
		expect(r.stderr).toContain(why);
		expect(r.status).toBe(2);
		expect(readLog()).toBe(before);
	});
});
