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
 * commit sweeps in a neighbour's work, leaves a new file behind, or names the
 * wrong commit as the session's own.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { freshSandbox, live, store } from "./lib/arbiter-testkit";
import { shellQuote, writeFaultyGit } from "./lib/git-fault-fake";
import { initGitRepo } from "./lib/git-fixture";
import { installLib } from "./lib/lib-install-testkit";
import {
	cutInReplay,
	cutShellFunction,
	plantSequencer,
	ROOT,
} from "./lib/precommit-gate-testkit";
import { makeProcRoot, writeCwd } from "./lib/proc-fake";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "commit-paths.js");

let hooks = "";
const sb = freshSandbox((s) => {
	hooks = path.join(s.dir, "hooks");
	fs.mkdirSync(hooks);
	initGitRepo(s.repo, hooks);
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

const ceiling = (ms: number) => ({
	...process.env,
	WFC_COMMIT_LOCK_CEILING_MS: String(ms),
});
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
		refused(["-m", "x", "--"], /no paths after `--`.*neighbour's staged/s);
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
		fs.writeFileSync(hook, `#!/bin/sh\ntouch "${path.join(sb.dir, "ran")}"\n`);
		fs.chmodSync(hook, 0o755);
		write("new.md");
		lands(["-m", "x", "--", "new.md"]);
		expect(fs.existsSync(path.join(sb.dir, "ran"))).toBe(true);
	});

	/** Commits `new.md` while the post-commit hook lands a neighbour's commit on top. */
	const neighbourOnTop = () => {
		const hook = path.join(hooks, "post-commit");
		fs.writeFileSync(
			hook,
			'#!/bin/sh\ngit update-ref HEAD "$(git commit-tree HEAD^{tree} -p HEAD -m neighbour)"\n',
		);
		fs.chmodSync(hook, 0o755);
		write("new.md");
		const r = run(["-m", "mine", "--", "new.md"]);
		expect(r.status).toBe(0);
		expect(git("log", "-1", "--format=%s").trim()).toBe("neighbour");
		const mine = git("log", "-1", "--format=%h %s", "HEAD^").trim();
		expect(r.stdout).toContain(`committed ${mine}\n`);
	};

	it("names its own commit where a neighbour commits during the post-commit hook (#1161)", () => {
		neighbourOnTop();
	});

	it("names its own commit on a branch whose name holds `]`", () => {
		git("checkout", "-qb", "a]b");
		neighbourOnTop();
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

describe("--patch: your own lines of a shared file, the working tree never written (#801)", () => {
	/** a.md at HEAD reads `a`; yours adds a line above it, theirs one below. */
	const shared = () => {
		write("a.md", "mine\na\ntheirs\n");
		const diff = git("diff", "HEAD", "-U0", "--", "a.md");
		// Theirs is the last hunk; cut it.
		const mine = diff.slice(0, diff.lastIndexOf("@@ -1,0"));
		fs.writeFileSync(path.join(sb.dir, "mine.patch"), mine);
		return path.join(sb.dir, "mine.patch");
	};
	const readBytes = (rel: string) => fs.readFileSync(path.join(sb.repo, rel));
	const readPrivates = () =>
		fs
			.readdirSync(path.join(sb.repo, ".git"))
			.filter((f) => f.startsWith("commit-paths-"));

	it("commits only the patch's hunk, leaves the neighbour's line in the working tree unwritten, and syncs the shared index", () => {
		const patch = shared();
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
		const patch = shared();
		write("new.md");
		write("other.md");
		const r = run(["-m", "both", "--patch", patch, "--", "new.md"]);
		expect(r.status).toBe(0);
		expect(readCommitted()).toBe("both\nM\ta.md\nA\tnew.md");
		expect(git("status", "--porcelain")).toBe(" M a.md\n?? other.md\n");
	});

	it("removes a whole path gone from disk that .gitignore now covers (#1960)", () => {
		const patch = shared();
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
		const patch = shared();
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
		const patch = shared();
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

	it("refuses a file both in the patch and named whole, and a patch that does not apply, writing neither index", () => {
		const patch = shared();
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

	it("commits a rename, resetting both its sides in the shared index", () => {
		git("mv", "a.md", "moved.md");
		const patch = path.join(sb.dir, "mv.patch");
		fs.writeFileSync(patch, git("diff", "--cached", "-M", "HEAD"));
		git("reset", "-q");
		const r = run(["-m", "move", "--patch", patch]);
		expect(r.status).toBe(0);
		expect(readCommitted()).toBe("move\nR100\ta.md\tmoved.md");
		expect(git("diff", "--cached", "--name-only")).toBe("");
	});

	it("warns where the shared index held a staged copy of a patched file, which the reset replaces, naming the file and how to restage it", () => {
		const patch = shared();
		write("a.md", "staged\n");
		git("add", "a.md");
		write("a.md", "mine\na\ntheirs\n");
		const r = run(["-m", "mine", "--patch", patch]);
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(
			/held a staged copy of a\.md other than HEAD's.*restage it from there/s,
		);
		expect(git("diff", "--cached", "--name-only")).toBe("");
	});

	it("exits 4 where the commit landed but the shared index stayed locked, giving the reset to run and saying never to re-run", () => {
		const hook = path.join(hooks, "post-commit");
		fs.writeFileSync(hook, "#!/bin/sh\ntouch .git/index.lock\n");
		fs.chmodSync(hook, 0o755);
		const patch = shared();
		const r = runInProcess(SCRIPT, ["-m", "mine", "--patch", patch], {
			cwd: sb.repo,
			env: { ...process.env, WFC_COMMIT_LOCK_CEILING_MS: "300" },
		});
		expect(r.status).toBe(4);
		expect(git("show", "HEAD:a.md")).toBe("mine\na\n");
		expect(r.stderr).toMatch(
			/Do not re-run this command: the commit has landed.*git reset -q -- ':\(top,literal\)a\.md'/s,
		);
		fs.rmSync(path.join(sb.repo, ".git", "index.lock"));
	});

	it("refuses --patch given twice, leaving the index as it was", () => {
		const patch = shared();
		const before = readIndex();
		const r = run(["-m", "x", "--patch", patch, "--patch", patch]);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/give --patch once/);
		expect(readIndex()).toBe(before);
	});

	it("runs the hooks against the private index, and a refusal touches neither the shared index nor the tree, leaves no private index and says a re-run is safe", () => {
		const hook = path.join(hooks, "pre-commit");
		fs.writeFileSync(
			hook,
			'#!/bin/sh\necho "index=$GIT_INDEX_FILE" >&2\nif [ -f gate-refuses ]; then echo "gate: fix the widget" >&2; exit 1; fi\n',
		);
		fs.chmodSync(hook, 0o755);
		const patch = shared();
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

	it("keeps its own message while a neighbour's commit writes the shared COMMIT_EDITMSG under its hooks (#2638)", () => {
		hookScript(
			"commit-msg",
			'echo "neighbour message" > "$(git rev-parse --git-dir)/COMMIT_EDITMSG"',
		);
		const r = run(["-m", "mine", "--patch", shared()]);
		expect(r.status).toBe(0);
		expect(readCommitted()).toBe("mine\nM\ta.md");
		expect(readPrivates()).toEqual([]);
	});

	it("hands prepare-commit-msg and commit-msg the message file as git does, committing what they leave in it", () => {
		hookScript("prepare-commit-msg", 'printf "\\nsource=%s\\n" "$2" >> "$1"');
		hookScript("commit-msg", 'printf "checked  \\n\\n\\n" >> "$1"');
		const r = run(["-m", "mine", "--patch", shared()]);
		expect(r.status).toBe(0);
		expect(git("log", "-1", "--format=%B")).toBe(
			"mine\n\nsource=message\nchecked\n\n",
		);
		expect(git("reflog", "-1", "--format=%gs")).toBe("commit: mine\n");
	});

	it("refuses a message the hooks leave empty, nothing written", () => {
		hookScript("commit-msg", ': > "$1"');
		const tip = readHead();
		const r = run(["-m", "mine", "--patch", shared()]);
		expect(r.status).toBe(3);
		expect(r.stderr).toMatch(
			/the prepare-commit-msg or commit-msg hook left the message empty.*Read what that hook printed above\. Nothing written\./,
		);
		expect(readHead()).toBe(tip);
	});

	it("refuses a pre-commit that leaves the index matching HEAD, nothing written", () => {
		hookScript("pre-commit", "git read-tree HEAD");
		const tip = readHead();
		const r = run(["-m", "mine", "--patch", shared()]);
		expect(r.status).toBe(3);
		expect(r.stderr).toMatch(
			/pre-commit hook left the index matching HEAD, so there is nothing to commit\. Read what the hook printed above/,
		);
		expect(readHead()).toBe(tip);
	});

	it("strips comment lines where commit.cleanup is strip, as git commit -m does", () => {
		git("config", "commit.cleanup", "strip");
		hookScript("commit-msg", 'echo "# a comment" >> "$1"');
		expect(run(["-m", "mine", "--patch", shared()]).status).toBe(0);
		expect(git("log", "-1", "--format=%B")).toBe("mine\n\n");
	});

	it("signs where commit.gpgSign is set, refusing as git commit does when signing fails", () => {
		git("config", "commit.gpgSign", "true");
		git("config", "gpg.program", "false");
		const tip = readHead();
		const r = run(["-m", "mine", "--patch", shared()]);
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
		const r = run(["-m", "mine", "--patch", shared()]);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(
			/MERGE_HEAD is set: a merge, cherry-pick or revert is in progress.*Finish or abort it first\. Nothing written\./,
		);
		expect(readIndex()).toBe(before);
	});

	/**
	 * A pre-commit that lands a neighbour's commit, `change` run against a
	 * scratch index of HEAD — on the first run only, or on every one with
	 * `always` — so the --patch commit's ref update meets a moved HEAD.
	 */
	const neighbourRaces = (change: string, always = false) => {
		const mark = path.join(sb.dir, "raced");
		hookScript(
			"pre-commit",
			[
				`if ${always} || [ ! -f ${shellQuote(mark)} ]; then`,
				`  : > ${shellQuote(mark)}`,
				`  export GIT_INDEX_FILE=${shellQuote(path.join(sb.dir, "neighbour.index"))}`,
				"  git read-tree HEAD",
				`  ${change}`,
				'  git update-ref HEAD "$(git commit-tree "$(git write-tree)" -p HEAD -m neighbour)"',
				// As a neighbour's commit leaves the shared index: matching its HEAD.
				"  env -u GIT_INDEX_FILE git reset -q",
				"fi",
			].join("\n"),
		);
	};
	// commit-paths has no clock seam, so the give-up is reached on real time
	// through the ceiling override. Wide: a race clears in one retry, its hooks
	// a fraction of a second. Short: spent by the first retry's backoff alone.
	const WideCeilingMs = 60_000;
	const ShortCeilingMs = 300;

	it("rebuilds on the new HEAD and commits there, where a neighbour's commit moves HEAD while the hooks run (#3280)", () => {
		write("held.md");
		git("add", "held.md");
		git("commit", "-qm", "seed held");
		neighbourRaces(
			'git update-index --add --cacheinfo "100644,$(echo edited | git hash-object -w --stdin),held.md"',
		);
		const r = runWith(
			["-m", "mine", "--patch", shared()],
			ceiling(WideCeilingMs),
		);
		expect(r.stderr).toContain(
			"HEAD moved under the commit — a neighbour's commit landed first — so git made none. Waiting up to 60.0s in all, retrying.",
		);
		expect(r.status).toBe(0);
		expect(readCommitted()).toBe("mine\nM\ta.md");
		expect(readCommitted("HEAD~1")).toBe("neighbour\nM\theld.md");
		expect(git("show", "HEAD:a.md")).toBe("mine\na\n");
		expect(git("diff", "--cached", "--name-only")).toBe("");
		expect(readPrivates()).toEqual([]);
		expect(readLastOutcome()?.[1]).toBe("committed");
	});

	it("refuses, exit 2, where the patch no longer applies on the HEAD a neighbour moved it to", () => {
		neighbourRaces("git rm -q --cached a.md");
		const r = runWith(
			["-m", "mine", "--patch", shared()],
			ceiling(WideCeilingMs),
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(
			/the patch (does not apply to|was not cut against) HEAD.*`git diff HEAD -U0 -- <path>`.*Nothing written\.\n$/s,
		);
		expect(readCommitted()).toBe("neighbour\nD\ta.md");
		expect(readPrivates()).toEqual([]);
		expect(readLastOutcome()?.[1]).toBe("refused");
	});

	it("stops at the ceiling where HEAD keeps moving under the hooks", () => {
		neighbourRaces("true", true);
		const r = runWith(
			["-m", "mine", "--patch", shared()],
			ceiling(ShortCeilingMs),
		);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("Waiting up to 0.3s in all, retrying.");
		expect(r.stderr).toContain(
			"gave up after 0.3s: HEAD kept moving under the commit, so neighbours are committing faster than it can land. Nothing was committed.",
		);
		expect(git("show", "HEAD:a.md")).toBe("a\n");
		expect(readPrivates()).toEqual([]);
		expect(readLastOutcome()?.[1]).toBe("lock-ceiling");
	});
});

describe("a live neighbour's claim on a named path (mantahostels#1539)", () => {
	/** A live session other than the committer, holding `rel` with the tree's bytes pinned. */
	const neighbour = (rel: string) => {
		const alice = live(sb, "alice", "Wayfinder 1584");
		store.acquire(rel, alice);
		store.recordContent(rel, alice);
	};

	it("prints the commit guard's warning, naming the path and holder, and commits anyway", () => {
		write("a.md", "alice's unsaved edit\n");
		neighbour("a.md");
		const r = run(["-m", "swept", "--", "a.md"]);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("This commit names a.md");
		expect(r.stderr).toContain("(Wayfinder 1584)");
		expect(r.stderr).toContain("swept in under your message");
		expect(r.stderr).toContain("mantahostels#1539");
		expect(r.stderr).toContain("declare the sweep");
		expect(r.stderr).toContain("  Swept: a.md (Wayfinder 1584)");
		expect(r.stderr).toContain("not a refusal");
		expect(readCommitted()).toBe("swept\nM\ta.md");
	});

	it("points at the session's other paths where the pathspec names some", () => {
		write("a.md", "alice's unsaved edit\n");
		write("mine.md");
		neighbour("a.md");
		const r = run(["-m", "swept", "--", "a.md", "mine.md"]);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("This commit names a.md");
		expect(r.stderr).toContain("Commit your own paths instead");
		expect(r.stderr).not.toContain("declare the sweep");
	});

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

		write("a.md", "alice's unsaved edit\n");
		neighbour("a.md");
		const { NODE_PATH: _, ...env } = process.env;
		const r = spawnSync(
			"node",
			[path.join(plugin, "commit-paths.js"), "-m", "plugin", "--", "a.md"],
			{ cwd: sb.repo, env, encoding: "utf8" },
		);
		expect(r.stderr).not.toContain("Cannot find module");
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("This commit names a.md");
		expect(readCommitted()).toBe("plugin\nM\ta.md");
	});

	it("stays silent where no neighbour holds the path", () => {
		write("a.md", "my edit\n");
		const r = run(["-m", "mine", "--", "a.md"]);
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
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
			`#!/bin/sh\nset -e\nWFC_PLUGIN_ROOT=${shellQuote(ROOT)}\n${cutInReplay()}\n${cutShellFunction("release_committed_claims")}\nrelease_committed_claims\n`,
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

describe("the index lock (#585) — wait, retry, and stop at the ceiling", () => {
	const lockFile = () => path.join(sb.repo, ".git", "index.lock");

	/**
	 * The script as a child process, so this test can act while it waits: `onHeld`
	 * runs once its wait-start line appears.
	 */
	const waiter = (args: string[], env: NodeJS.ProcessEnv, onHeld: () => void) =>
		new Promise<{ status: number | null; stderr: string }>((resolve) => {
			// spawn-kept: two processes at once.
			const child = spawn(process.execPath, [SCRIPT, ...args], {
				cwd: sb.repo,
				env: { ...env, CLAUDE_PROJECT_DIR: sb.repo },
			});
			let stderr = "";
			child.stderr.on("data", (d) => {
				const first = !stderr.includes(" is held; ");
				stderr += d;
				if (first && stderr.includes(" is held; ")) onHeld();
			});
			child.on("close", (status) => resolve({ status, stderr }));
		});

	/**
	 * A real `git commit` in the fixture, spawned by this test's process, whose
	 * pre-commit holds until `release()` — so it keeps the index lock as a
	 * neighbour's does, for exactly as long as the test needs. Resolves once the
	 * lock is on disk; `done` settles when the holder exits.
	 */
	const holder = async (cwd = sb.repo) => {
		const released = path.join(sb.dir, "released");
		const hook = path.join(hooks, "pre-commit");
		// A 20 s bound, so a failing test cannot leave the holder running.
		fs.writeFileSync(
			hook,
			`#!/bin/sh\n[ -z "$HOLD" ] && exit 0\ni=0\nwhile [ ! -f ${shellQuote(released)} ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done\n`,
		);
		fs.chmodSync(hook, 0o755);
		const at = (...args: string[]) =>
			execFileSync("git", args, { cwd, encoding: "utf8" });
		fs.writeFileSync(path.join(cwd, "held.md"), "held.md\n");
		at("add", "held.md");
		at("commit", "-qm", "seed held");
		fs.writeFileSync(path.join(cwd, "held.md"), "edited\n");
		const lock = path.resolve(
			cwd,
			at("rev-parse", "--git-path", "index.lock").trim(),
		);
		// The pathspec form, as sessions commit: a plain `git commit` gives the
		// lock back before its hooks run.
		const child = spawn("git", ["commit", "-qm", "holder", "--", "held.md"], {
			cwd,
			env: { ...process.env, HOLD: "1" },
			stdio: "ignore",
		});
		const done = new Promise((resolve) => child.on("close", resolve));
		for (let i = 0; i < 200 && !fs.existsSync(lock); i++)
			await new Promise((r) => setTimeout(r, 10));
		expect(fs.existsSync(lock)).toBe(true);
		return {
			pid: child.pid,
			done,
			release: () => fs.writeFileSync(released, ""),
		};
	};

	it("waits out a lock met at the intent-add, then commits", async () => {
		write("new.md");
		fs.writeFileSync(lockFile(), "");
		const r = await waiter(
			["-m", "after wait", "--", "new.md"],
			ceiling(5000),
			() => setTimeout(() => fs.rmSync(lockFile()), 200),
		);
		expect(r.stderr).toMatch(
			/index\.lock is held; no live git process in this worktree could be found to name\. Waiting up to 5\.0s in all, retrying\./,
		);
		expect(r.status).toBe(0);
		expect(readCommitted()).toBe("after wait\nA\tnew.md");
		const [, code, waited] = readLastOutcome() ?? [];
		expect(code).toBe("committed");
		expect(Number(waited)).toBeGreaterThanOrEqual(0.2);
	});

	it("names the lock's git process from a WFC_PROC root, not the real /proc (#3538)", async () => {
		const fake = makeProcRoot();
		fake.proc(4242, { comm: "git", argv: "git commit -m fake" });
		writeCwd(fake.root, "4242", sb.repo);
		write("new.md");
		fs.writeFileSync(lockFile(), "");
		const r = await waiter(
			["-m", "after wait", "--", "new.md"],
			{ ...ceiling(5000), WFC_PROC: fake.root },
			() => setTimeout(() => fs.rmSync(lockFile()), 200),
		).finally(fake.remove);
		expect(r.stderr).toContain(
			"index.lock is held; git pid 4242 is live in this worktree (`git commit -m fake`)",
		);
		expect(r.status).toBe(0);
	});

	it("waits out a neighbour's commit met at the commit step, naming its git process and session", async () => {
		live(sb, "alice", "Wayfinder 1584");
		write("a.md", "edited\n");
		const { pid, done, release } = await holder();
		const r = await waiter(
			["-m", "mine", "--", "a.md"],
			ceiling(5000),
			release,
		);
		await done;
		expect(r.stderr).toContain(
			`git pid ${pid} is live in this worktree (\`git commit -qm holder -- held.md\`), under session "Wayfinder 1584"`,
		);
		expect(r.status).toBe(0);
		expect(readCommitted()).toBe("mine\nM\ta.md");
		expect(readCommitted("HEAD~1")).toBe("holder\nM\theld.md");
	});

	it("stops at a ceiling set under a second, leaving the lock untouched and naming its age and the removal command", () => {
		write("new.md");
		const before = readIndex();
		const tip = readHead();
		fs.writeFileSync(lockFile(), "a crashed git's");
		const mtime = fs.statSync(lockFile()).mtimeMs;
		const r = runWith(["-m", "x", "--", "new.md"], ceiling(300));
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(
			/gave up after 0\.3s waiting for \S*index\.lock; it is \d+s old, no live git process in this worktree/,
		);
		expect(r.stderr).toContain("Nothing was intent-added or committed.");
		expect(r.stderr).toContain("No git process is running in this worktree");
		expect(r.stderr).toContain(`rm -f '${fs.realpathSync(lockFile())}'`);
		expect(r.stderr).toContain("this command never does");
		expect(fs.readFileSync(lockFile(), "utf8")).toBe("a crashed git's");
		expect(fs.statSync(lockFile()).mtimeMs).toBe(mtime);
		expect(readIndex()).toBe(before);
		expect(readHead()).toBe(tip);
		const [, code, waited] = readLastOutcome() ?? [];
		expect(code).toBe("lock-ceiling");
		expect(Number(waited)).toBeGreaterThanOrEqual(0.3);
		expect(Number(waited)).toBeLessThan(1);
	});

	it("at the ceiling with a live holder, names it and prints no removal command", async () => {
		write("a.md", "edited\n");
		const { pid, done, release } = await holder();
		const r = runWith(["-m", "x", "--", "a.md"], ceiling(300));
		release();
		await done;
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(
			new RegExp(`it is \\d+s old, git pid ${pid} is live in this worktree `),
		);
		expect(r.stderr).toContain("under no session the registry names");
		expect(r.stderr).not.toContain("rm -f");
	});

	it("does not count a live git in a worktree nested inside this one, whose index is its own", async () => {
		const nested = path.join(sb.repo, "nested");
		git("worktree", "add", "-q", "-b", "side", nested);
		const { done, release } = await holder(nested);
		write("new.md");
		fs.writeFileSync(lockFile(), "a crashed git's");
		const r = runWith(["-m", "x", "--", "new.md"], ceiling(300));
		release();
		await done;
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("no live git process in this worktree");
		expect(r.stderr).toContain(`rm -f '${fs.realpathSync(lockFile())}'`);
	});

	it("passes a non-lock refusal of the intent-add through as exit 3, saying nothing was intent-added", () => {
		write("new.md");
		const before = readIndex();
		const dotGit = path.join(sb.repo, ".git");
		fs.chmodSync(dotGit, 0o555);
		let r: ReturnType<typeof run>;
		try {
			r = runWith(["-m", "x", "--", "new.md"], ceiling(300));
		} finally {
			fs.chmodSync(dotGit, 0o755);
		}
		expect(r.status).toBe(3);
		expect(r.stderr).toContain("Permission denied");
		expect(r.stderr).not.toContain(" is held;");
		expect(r.stderr).toMatch(/nothing was intent-added\. Re-run once/);
		expect(r.stderr).not.toContain("left in the index");
		expect(readIndex()).toBe(before);
		expect(readLastOutcome()?.slice(1)).toEqual(["git-refused", "0.0", "0.0"]);
	});

	/**
	 * A `git` at WFC_GIT whose `commit` first commits `held.md` as a
	 * neighbour would, then refuses as git does when that moves HEAD under it —
	 * on the first commit only, or on every one with `always`. All else is git's.
	 */
	const headRacer = (always = false) => {
		write("held.md");
		git("add", "held.md");
		git("commit", "-qm", "seed held");
		write("held.md", "edited\n");
		const mark = path.join(sb.dir, "raced");
		const racer = writeFaultyGit(
			{ first: "commit" },
			{
				script: [
					`if ${always} || [ ! -f ${shellQuote(mark)} ]; then`,
					`  : > ${shellQuote(mark)}`,
					'  "$REAL_GIT" commit -qm neighbour -- held.md >/dev/null 2>&1',
					`  echo "fatal: cannot lock ref 'HEAD': is at $("$REAL_GIT" rev-parse HEAD) but expected $("$REAL_GIT" rev-parse HEAD~1)" >&2`,
					"  exit 128",
					"fi",
				].join("\n"),
			},
			{ under: sb.dir },
		);
		return (ms: number) => ({
			...ceiling(ms),
			WFC_GIT: racer.git,
		});
	};

	it("waits out a neighbour's commit moving HEAD under the commit, then commits on top of it (#819)", () => {
		const env = headRacer();
		write("a.md", "edited\n");
		const r = runWith(["-m", "mine", "--", "a.md"], env(60_000));
		expect(r.stderr).toContain(
			"HEAD moved under the commit — a neighbour's commit landed first — so git made none. Waiting up to 60.0s in all, retrying.",
		);
		expect(r.stderr).not.toContain(" is held;");
		expect(r.status).toBe(0);
		expect(readCommitted()).toBe("mine\nM\ta.md");
		expect(readCommitted("HEAD~1")).toBe("neighbour\nM\theld.md");
		const [, code, waited] = readLastOutcome() ?? [];
		expect(code).toBe("committed");
		expect(Number(waited)).toBeGreaterThanOrEqual(0.1);
	});

	it("stops at the ceiling where HEAD keeps moving, naming no lock to remove", () => {
		const env = headRacer(true);
		write("a.md", "edited\n");
		const r = runWith(["-m", "mine", "--", "a.md"], env(300));
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			"gave up after 0.3s: HEAD kept moving under the commit, so neighbours are committing faster than it can land. Nothing was committed.",
		);
		expect(r.stderr).not.toContain("rm -f");
		expect(readLastOutcome()?.[1]).toBe("lock-ceiling");
	});

	it("passes a stale HEAD.lock through as exit 3, relaying the git error — a `cannot lock ref` that is not HEAD moving", () => {
		write("a.md", "edited\n");
		const tip = readHead();
		const headLock = path.join(sb.repo, ".git", "HEAD.lock");
		fs.writeFileSync(headLock, "");
		let r: ReturnType<typeof run>;
		try {
			r = runWith(["-m", "x", "--", "a.md"], ceiling(300));
		} finally {
			fs.rmSync(headLock);
		}
		expect(r.status).toBe(3);
		expect(r.stderr).toMatch(
			/fatal: cannot lock ref 'HEAD': Unable to create '[^']*HEAD\.lock': File exists\./,
		);
		expect(r.stderr).not.toContain("HEAD moved");
		expect(r.stderr).toContain("git or a hook refused the commit (exit 128)");
		expect(readHead()).toBe(tip);
		expect(readLastOutcome()?.slice(1)).toEqual(["git-refused", "0.0", "0.0"]);
	});

	it("jitters the backoff, so a waiter's retries stretch with its draw", async () => {
		write("a.md", "edited\n");
		fs.writeFileSync(lockFile(), "");
		// Halves spec #574's backoff, so each gap's floor below clears the
		// unjittered nap by 250-500 ms, more than a loaded machine's spawn delay.
		const ceilingMs = 90_000;
		/** Commit attempts the waiter must make while the lock is held. */
		const retries = 4;
		// The jitter's draw, fixed near its top, so each nap is ~1.5x unjittered.
		const draw = 0.999;
		// git's own trace2 events: each attempt's start and exit, seen from
		// outside the script.
		const trace = path.join(sb.dir, "a.md.trace2");
		const readCommits = () => {
			if (!fs.existsSync(trace)) return [];
			const events: {
				event: string;
				sid: string;
				time: string;
				argv?: string[];
			}[] = fs
				.readFileSync(trace, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
				// A hook's own git calls carry a nested sid.
				.filter((e: { sid: string }) => !e.sid.includes("/"));
			const exits = new Map(
				events.filter((e) => e.event === "exit").map((e) => [e.sid, e.time]),
			);
			return events
				.filter((e) => e.event === "start" && e.argv?.[1] === "commit")
				.map((e) => ({
					start: Date.parse(e.time),
					exit: Date.parse(exits.get(e.sid) ?? ""),
				}));
		};
		const done = waiter(
			["-m", "a.md", "--", "a.md"],
			{
				...ceiling(ceilingMs),
				WFC_COMMIT_LOCK_JITTER: String(draw),
				GIT_TRACE2_EVENT: trace,
			},
			() => undefined,
		);
		// Free the lock once the waiter has made its attempts, not after a fixed
		// wait, which a loaded machine's slow start-up outlasted (#1185).
		// Residual: a machine too slow for four attempts in 60 s still fails,
		// naming the count.
		const deadline = Date.now() + 60_000;
		while (readCommits().length < retries && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 25));
		}
		const seen = readCommits().length;
		fs.rmSync(lockFile());
		const result = await done;
		// Status first: a crashed waiter's stderr says more than its count.
		expect(result.status, result.stderr).toBe(0);
		expect(seen, "attempts when the lock was freed").toBeGreaterThanOrEqual(
			retries,
		);

		// Real time, as the script's sleep takes no injected clock. Each gap runs
		// from one refused attempt's exit to the next one's start, so git's own
		// run time drops out, and holds a whole nap — load only lengthens it.
		// Residual: the Math.random fallback behind the override goes untested,
		// as any assertion on a random draw is the chance failure this test
		// replaced (#3479).
		const attempts = readCommits();
		const scale = ceilingMs / 180_000;
		// commit-paths.js's FIRST_NAP_MS, doubling to MAX_NAP_MS.
		for (const [i, nap] of [1000, 2000, 4000].entries()) {
			const floor = Math.min(nap * scale * (0.5 + draw), 5000 * scale);
			const gap = attempts[i + 1].start - attempts[i].exit;
			expect(gap, `the nap before attempt ${i + 2}`).toBeGreaterThanOrEqual(
				floor,
			);
		}
	});

	it("logs a run that met no lock as waiting 0.0s", () => {
		write("new.md");
		expect(run(["-m", "x", "--", "new.md"]).status).toBe(0);
		expect(readLastOutcome()?.slice(1)).toEqual(["committed", "0.0", "0.0"]);
	});
});

describe("--tree: the tree the commit would carry, nothing written (#1695)", () => {
	const readLog = () => {
		try {
			return fs.readFileSync(store.paths.commitPathsLog(), "utf8");
		} catch {
			return "";
		}
	};
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

	it("prints the tree a plain commit then carries — an edit, a new file and a deletion — whatever else the shared index holds", () => {
		write("gone.md");
		write("staged.md", "old\n");
		git("add", "gone.md", "staged.md");
		git("commit", "-qm", "seed");
		write("staged.md", "a neighbour's staged copy\n");
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

	it.each([
		["a message", ["-m", "x", "--", "a.md"], "takes no message"],
		["no change", ["--", "a.md"], "nothing to commit"],
		["no paths", [], "no paths after `--`"],
	])("refuses %s, logging no outcome", (_, args, why) => {
		const before = readLog();
		const r = run(["--tree", ...args]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(why);
		expect(r.stdout).toBe("");
		expect(readLog()).toBe(before);
	});

	it("refuses a patch already committed, as the commit would", () => {
		write("a.md", "mine\na\n");
		const patch = path.join(sb.dir, "mine.patch");
		fs.writeFileSync(patch, git("diff", "HEAD", "-U0", "--", "a.md"));
		expect(run(["-m", "x", "--patch", patch]).status).toBe(0);
		const r = run(["--tree", "--patch", patch]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("was not cut against HEAD");
	});
});
