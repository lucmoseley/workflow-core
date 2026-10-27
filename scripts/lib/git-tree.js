/*
 * git-tree.js — the git calls the guard parser's git walk and the guard
 * hosts need (workflow-core#2785, programme workflow-core#2733): which working tree of which
 * repository a directory is, the full ref a push source names, a tree's top
 * level and git directory, and which files a patch touches.
 *
 * AN ADAPTER: lib/shell-parse.js's walkGit takes the tree class as a port,
 * lib/lander-on-push.js the symbolic name, the guard hosts' ports
 * (commit-form, pull-form, registry-atomicity, divergence-row) the top level
 * and git directory (workflow-core#2883), and these are the real ones;
 * lib/git-tree-fake.js is the fake of the first two, held to them by git-tree.contract.test.ts. Every call runs the real `git` through lib/git.js
 * under a timeout, and each distinct question is put to git once a process, its
 * outcome kept.
 *
 * FAIL OPEN (mantahostels#103 §6): a tree git cannot answer for, a timed-out
 * call included, is "unknown", which the walk records before it allows.
 */

const fs = require("node:fs");
const path = require("node:path");

const { caught } = require("./caught.js");
const {
	execGit,
	gitCommonDirOrThrow,
	HOOK_GIT_TIMEOUT_MS,
} = require("./git.js");

/**
 * @typedef {object} GitOutcome
 * @property {string | null} out stdout, every trailing newline off as `$(…)`
 *   strips them; null where git exited non-zero or did not finish
 * @property {string} stdout what git printed either way
 * @property {boolean} timedOut
 */

/** @type {Map<string, GitOutcome>} */
const memo = new Map();

/**
 * `read`'s outcome under `key`, read once a process.
 * @param {string} key
 * @param {() => string} read git's stdout; throws where git exits non-zero
 * @returns {GitOutcome}
 */
function remembered(key, read) {
	const hit = memo.get(key);
	if (hit) return hit;
	/** @type {GitOutcome} */
	let outcome;
	try {
		const stdout = read();
		outcome = { out: stdout.replace(/\n+$/, ""), stdout, timedOut: false };
	} catch (e) {
		const err = caught(e);
		outcome = {
			out: null,
			stdout: err.stdout ?? "",
			timedOut: err.code === "ETIMEDOUT",
		};
	}
	memo.set(key, outcome);
	return outcome;
}

/**
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {GitOutcome}
 */
const git = (args, timeoutMs) =>
	remembered(args.join("\0"), () =>
		execGit(args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: timeoutMs,
		}),
	);

/**
 * Absolute and symlink-resolved; "" for "" and for a path that will not
 * resolve, which every caller reads as unknown. Each caller hands it a path
 * already known to exist.
 * @param {string} p
 * @returns {string}
 */
function canon(p) {
	if (!p) return "";
	try {
		return fs.realpathSync(path.resolve(p));
	} catch {
		return "";
	}
}

/**
 * Is `dir` inside a git repository at all, as a FILESYSTEM fact? Asked only
 * once git has refused to answer for the directory, to tell git's two refusals
 * apart (mantahostels#253).
 *
 * It cannot be asked of git. `rev-parse` exits 128 both for "this is not a
 * repository" and for genuine breakage, with the same stderr: a `.git` file
 * pointing at a gitdir that is gone, an unreadable `.git`, and a garbage HEAD
 * all print `fatal: not a git repository`. So the ancestry is walked for a
 * `.git` entry — a directory, or the file a linked worktree and a submodule
 * leave. Found means git failed for one of the other reasons, so the caller
 * stays unknown.
 *
 * The path is canonicalised FIRST, because the walk is lexical and git
 * resolves the physical directory: with `link -> /real/proj/sub` and the
 * broken marker at /real/proj/.git, stripping components off the spelling
 * never visits /real/proj.
 *
 * It ignores GIT_CEILING_DIRECTORIES and $GIT_DIR. Both can only make it
 * answer "in a repo" where git said no, which records too.
 * @param {string} dir
 */
function isInsideAnyRepo(dir) {
	let p = canon(dir);
	if (!p) return true;
	while (p.length > 1) {
		if (fs.existsSync(`${p}/.git`)) return true;
		p = p.slice(0, p.lastIndexOf("/"));
	}
	return fs.existsSync("/.git");
}

/**
 * @typedef {"shared" | "linked" | "other" | "unknown"} TreeClass
 *   shared   this repo's shared (main) working tree
 *   linked   a linked worktree of this repo, which keeps its own index but
 *            runs the same commit hooks (mantahostels#1213, mantahostels#344)
 *   other    judged, and neither — another repository, no repository at all,
 *            or a path with nothing at it
 *   unknown  NOT judged: git could not answer for the directory, or it is ""
 *            — a strict walk's unresolved tree (workflow-core#311). The caller RECORDS this
 *            before allowing (mantahostels#147)
 */

/**
 * The tree classifier for the repo rooted at `root`, walkGit's `treeClass`
 * port. The repo's common git dir is resolved here, once: where it will not
 * resolve this THROWS, its message the record the guard logs, because
 * with the repo unresolved every tree reads as another repo's and the guard
 * reaches a verdict on no command at all.
 * @param {string} root the host repository's root
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {(dir: string) => TreeClass}
 */
function treeClassifier(root, { timeoutMs = HOOK_GIT_TIMEOUT_MS } = {}) {
	/* Tested BEFORE git sees it: `git -C ""` does not fail, it silently answers
	 * for the cwd's repo. */
	if (!root)
		throw new Error(
			"the repo root did not resolve — command allowed unchecked",
		);
	const found = commonDir(root, timeoutMs).out;
	if (found === null)
		throw new Error(
			`git could not resolve a git dir for ${root} — command allowed unchecked`,
		);
	const project = canon(found);
	if (!project)
		throw new Error(`empty git dir for ${root} — command allowed unchecked`);
	return (dir) => classify(dir, project, timeoutMs);
}

/**
 * @param {string} dir
 * @param {number} timeoutMs
 */
const commonDir = (dir, timeoutMs) =>
	remembered(`common-dir\0${dir}`, () =>
		gitCommonDirOrThrow(dir, {
			stdio: ["ignore", "pipe", "ignore"],
			timeout: timeoutMs,
		}),
	);

/**
 * @param {string} dir absolute, as the walk guarantees: a relative one would
 *   be read against the hook's cwd, not the session's
 * @param {string} project the repo's common git dir, canonical
 * @param {number} timeoutMs
 * @returns {TreeClass}
 */
function classify(dir, project, timeoutMs) {
	if (!dir) return "unknown";
	/* A path with nothing at it is JUDGED: git fails before it touches
	 * anything, so it is no more this repo's tree than another repo is
	 * (mantahostels#208). */
	if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory())
		return "other";
	const common = commonDir(dir, timeoutMs);
	if (common.out === null) {
		if (common.timedOut) return "unknown";
		/* A directory in NO repository is judged too (mantahostels#253). */
		return isInsideAnyRepo(dir) ? "unknown" : "other";
	}
	const gitdir = readGitDir(dir, { timeoutMs });
	if (gitdir === null) return "unknown";
	/* A path that will not canonicalise is unknown, not a confident "not this
	 * repo" built on an unresolved path. */
	const c = canon(common.out);
	const g = canon(gitdir);
	if (!c || !g) return "unknown";
	if (c !== project) return "other";
	return g === c ? "shared" : "linked";
}

/**
 * `git rev-parse --symbolic-full-name <src>` in the tree at `tree`, the
 * symbolicName port: `refs/heads/<b>` for a branch, `refs/tags/<t>` for a tag,
 * `HEAD` for a detached HEAD, and "" where git names no ref — an unresolvable
 * name, a sha, a name both a branch and a tag, or no repository.
 * @param {string} tree
 * @param {string} src
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {string}
 */
const readSymbolicName = (
	tree,
	src,
	{ timeoutMs = HOOK_GIT_TIMEOUT_MS } = {},
) =>
	git(["-C", tree, "rev-parse", "--symbolic-full-name", src], timeoutMs).out ??
	"";

/**
 * The top level of the tree at `dir`, `git rev-parse --show-toplevel`: a
 * linked worktree's own, not the host root's (workflow-core#2883). Null where git cannot
 * place `dir` — inside `.git`, no repository, or a timed-out call.
 * @param {string} dir
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {string | null}
 */
const readTopLevel = (dir, { timeoutMs = HOOK_GIT_TIMEOUT_MS } = {}) =>
	git(["-C", dir, "rev-parse", "--show-toplevel"], timeoutMs).out;

/**
 * The absolute git directory of the tree at `dir`: a linked worktree's own
 * under the common `.git/worktrees/`. Null where git cannot place `dir`.
 * @param {string} dir
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {string | null}
 */
const readGitDir = (dir, { timeoutMs = HOOK_GIT_TIMEOUT_MS } = {}) =>
	git(
		["-C", dir, "rev-parse", "--path-format=absolute", "--git-dir"],
		timeoutMs,
	).out;

/**
 * The absolute path of every file the patch file `file` touches, read as
 * lib/patch-files.js reads them: `git apply --numstat` from the top level of
 * the tree at `dir`, a rename's new name only. `file`, where relative, is
 * joined to `dir`. Null where the tree or the patch cannot be read, the caller
 * logging what that costs it.
 * @param {string} dir the tree the command runs in
 * @param {string} file the patch word, read through literal by the caller,
 *   which fails open itself where that word is not known
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {string[] | null}
 */
function patchFiles(dir, file, { timeoutMs = HOOK_GIT_TIMEOUT_MS } = {}) {
	const abs = file.startsWith("/") ? file : `${dir}/${file}`;
	const top = readTopLevel(dir, { timeoutMs });
	if (top === null || !isReadable(abs)) return null;
	const applied = git(
		["-C", top, "apply", "--numstat", "-z", "--unidiff-zero", abs],
		timeoutMs,
	);
	if (applied.timedOut) return null;
	/* One `<added>\t<deleted>\t<path>` field per file. Read whatever git
	 * printed, whatever the exit. */
	const fields = applied.stdout.split("\0");
	if (fields.at(-1) === "") fields.pop();
	if (fields.length === 0) return null;
	return fields.map((f) => `${top}/${f.replace(/^[^\t]*\t[^\t]*\t/, "")}`);
}

/** @param {string} p */
function isReadable(p) {
	try {
		fs.accessSync(p, fs.constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

module.exports = {
	treeClassifier,
	readSymbolicName,
	readTopLevel,
	readGitDir,
	patchFiles,
};
