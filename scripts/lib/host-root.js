/*
 * host-root.js — the one seam every script in the core uses to find the HOST
 * repository.
 *
 * THE CONTRACT: the main checkout owning `CLAUDE_PROJECT_DIR` where the harness
 * sets it, else the one owning the working directory, symlinks dereferenced
 * either way: in a linked worktree the parent of a git common dir called
 * `.git`, elsewhere the git top level. One answer for every caller in a
 * session: in a session launched in a linked worktree the harness hands its
 * hooks `CLAUDE_PROJECT_DIR` naming that worktree, and the Bash tool sets none,
 * so a hook's claim and a hand-run `release` meet in one store only because
 * both limbs map to the main checkout (#4482, #4493). A declared directory
 * whose `.git` is not a file is a main checkout or no checkout at all, and is
 * kept without asking git.
 * `resolveCommitHost()` is the other contract, the host a git hook is handed,
 * for a script that must agree with one; its docblock states it.
 *
 * TWO TREES A HOOK CAN MEAN (#4229). The host root is the main checkout, where
 * the shared stores live: claims, markers, ledgers. `sessionTree()` is the
 * session's own tree, a linked worktree of it where the session runs in one:
 * a hook reading `git status`, `HEAD`, the index or working files reads that.
 * The host root never says which tree is the session's; only the hook input's
 * `cwd` does. A script that writes tracked
 * files writes `worktreeRoot()`: through `hostRoot()` a worktree session's
 * write lands in the main checkout as an orphaned edit (#4438).
 *
 * NEVER `__dirname`. In a plugin install the core's files live in the plugin
 * cache, so a root resolved from this file's own location names the cache and
 * every host read lands in the wrong tree (mantahostels#3515).
 *
 * `__dirname` REMAINS CORRECT for locating a SIBLING of the core's own files —
 * `path.join(__dirname, "..", "session-arbiter.js")` spawns the copy that ships
 * with this one, which is what a plugin install wants.
 *
 * `WFC_REPO_ROOT` IS NOT READ HERE, deliberately. It is a test-injection point
 * a handful of scripts honour ahead of everything else (`lib/hook-block.js`'s
 * header gives the reason). Those callers spell it `process.env.WFC_REPO_ROOT ||
 * hostRoot()`.
 *
 * BYTE-IDENTICAL OUTPUT IS A CONSTRAINT, twice over. `lib/arbiter-core.js`'s
 * `stateDir()` slugs this into a directory name, and `lib/guard-log.sh` slugs
 * `gr_root()` into the same one — so the trailing-slash strip and the symlink
 * dereference live in both or in neither. `scripts/lib/guard-root.sh` is the
 * shell half; change the two together.
 */

const fs = require("node:fs");
const path = require("node:path");
const {
	execGit,
	gitCommonDir,
	gitCommonDirOrThrow,
	revParseWithCommonDirOrThrow,
} = require("./git.js");
const { caught } = require("./caught.js");
const { deref } = require("./deref.js");
const { checkoutOfCommonDir } = require("./main-checkout.js");
const { writeFd } = require("./write-fd.js");

/**
 * Only a trailing slash, and never the last one: a repo rooted at `/` would
 * otherwise normalise to the empty string. `/repo/` slugs to `-repo-` and
 * `/repo` to `-repo`, two state directories for one tree.
 * @param {string} dir
 * @returns {string}
 */
function stripSlash(dir) {
	return dir.length > 1 && dir.endsWith("/") ? dir.slice(0, -1) : dir;
}

/*
 * MEMOISED AND KEYED ON CWD (mantahostels#1775): without CLAUDE_PROJECT_DIR this forks
 * `git rev-parse`. Keyed rather than cached flat because the suite chdirs
 * between trees inside one vitest process, and a flat cache would answer for
 * whichever tree ran first. A FAILED git read is never memoised: it is a guess
 * a later call in the same process could get right.
 */
let memo = { key: "", value: "" };

/* The declared limb's, keyed on the dereferenced `CLAUDE_PROJECT_DIR`, under
 * the same rule: a failed git read is never memoised. */
let declaredMemo = { key: "", value: "" };

/**
 * The git top level of `cwd`, symlinks dereferenced. Throws where git will
 * not say.
 * @param {string} cwd
 * @param {number} [timeoutMs]
 * @returns {string}
 */
function gitTopLevel(cwd, timeoutMs) {
	return deref(
		execGit(["rev-parse", "--show-toplevel"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: timeoutMs,
		}).trim(),
	);
}

/**
 * The main checkout owning `cwd`, symlinks dereferenced: `main-checkout.js`'s
 * rule, else the git top level — a bare repository's worktree, a submodule or
 * a `--separate-git-dir` checkout has no main checkout to name. Throws where
 * git names no top level.
 * @param {string} cwd
 * @param {number} [timeoutMs]
 * @returns {string}
 */
function owningCheckout(cwd, timeoutMs) {
	const [top = "", common = ""] = revParseWithCommonDirOrThrow(
		cwd,
		["--show-toplevel"],
		{ timeout: timeoutMs },
	);
	return deref(checkoutOfCommonDir(common) ?? top);
}

/**
 * The host repository's root.
 * @param {string} [cwd] the directory the git limb asks from
 * @param {{ timeoutMs?: number, onTimeout?: () => void }} [opts] the git
 *   limb's ceiling, none by default; a read past it fails open to the working
 *   directory like any other, and calls `onTimeout`
 * @returns {string}
 */
function hostRoot(cwd = process.cwd(), { timeoutMs, onTimeout } = {}) {
	const declared = process.env.CLAUDE_PROJECT_DIR;
	if (declared)
		return declaredHost(deref(stripSlash(declared)), timeoutMs, onTimeout);
	if (memo.key === cwd) return memo.value;
	let value;
	try {
		value = owningCheckout(cwd, timeoutMs);
	} catch (e) {
		if (caught(e).code === "ETIMEDOUT") onTimeout?.();
		/* Fails open to the working directory (mantahostels#103 §6), silently: this is what
		 * the error log's own directory is derived from, so a report from here
		 * would recurse. */
		return deref(cwd);
	}
	memo = { key: cwd, value };
	return value;
}

/**
 * The main checkout owning a declared `CLAUDE_PROJECT_DIR`, or that directory
 * itself: where its `.git` is no file, so no linked worktree, and where git
 * will not answer, which fails open to it silently, as `hostRoot()`'s git limb
 * does and for the same reason.
 * @param {string} dir dereferenced, trailing slash stripped
 * @param {number} [timeoutMs]
 * @param {() => void} [onTimeout]
 * @returns {string}
 */
function declaredHost(dir, timeoutMs, onTimeout) {
	if (declaredMemo.key === dir) return declaredMemo.value;
	let linked = false;
	try {
		linked = fs.statSync(path.join(dir, ".git")).isFile();
	} catch {
		/* No `.git` at all: no checkout to map. */
	}
	let value = dir;
	if (linked) {
		try {
			value = owningCheckout(dir, timeoutMs);
		} catch (e) {
			if (caught(e).code === "ETIMEDOUT") onTimeout?.();
			return dir;
		}
	}
	declaredMemo = { key: dir, value };
	return value;
}

/**
 * The session's tree: the git top level of the hook input's `cwd`, symlinks
 * dereferenced. Takes the payload, or a core's context, whose `cwd` is the
 * payload's; where it carries none, the process's cwd. Null where git names no
 * top level — outside every repository, or git failing — never the host.
 * @param {{ cwd?: unknown }} input
 * @returns {string | null}
 */
function sessionTree({ cwd }) {
	const dir = typeof cwd === "string" && cwd ? cwd : process.cwd();
	try {
		return gitTopLevel(dir);
	} catch {
		return null;
	}
}

/**
 * The session's tree: the git top level of the working directory where that
 * is a linked worktree of the host repository, else `hostRoot()`. It is what a
 * test run reads and where a script writing tracked files writes (#4438).
 *
 * NOT `hostRoot()` ALONE (#2940). `hostRoot()` names the main checkout, so a
 * run launched inside a linked worktree would otherwise test the main
 * checkout's files and say nothing. State keyed on
 * the host stays there — the arbiter's directory on `hostRoot()`, the marker
 * store on the git common dir: only which files are under test follows the
 * worktree.
 *
 * With neither a `host` nor `CLAUDE_PROJECT_DIR`, the git top level alone:
 * `hostRoot()` would name the main checkout of that same repository, so the
 * common-dir comparison below could only agree, at three more git forks.
 * @param {string} [cwd]
 * @param {{ host?: string, timeoutMs?: number, onTimeout?: () => void }} [opts]
 *   `host`, where the caller already holds it, so the answer reads no ambient
 *   `CLAUDE_PROJECT_DIR` (#3327); else `hostRoot()`. `timeoutMs` bounds each
 *   git read, none by default; a read past it answers the host — the working
 *   directory where no host was given — and calls `onTimeout`
 * @returns {string}
 */
function worktreeRoot(
	cwd = process.cwd(),
	{ host: given, timeoutMs, onTimeout } = {},
) {
	if (!given && !process.env.CLAUDE_PROJECT_DIR) {
		try {
			return gitTopLevel(cwd, timeoutMs);
		} catch (e) {
			if (caught(e).code === "ETIMEDOUT") onTimeout?.();
			return hostRoot(cwd, { timeoutMs });
		}
	}
	const host = given ? deref(stripSlash(given)) : hostRoot(cwd);
	try {
		const top = gitTopLevel(cwd, timeoutMs);
		if (top === host) return host;
		const bound = { timeout: timeoutMs };
		return gitCommonDirOrThrow(cwd, bound) === gitCommonDirOrThrow(host, bound)
			? top
			: host;
	} catch (e) {
		if (caught(e).code === "ETIMEDOUT") onTimeout?.();
		/* Outside any repository there is no worktree to prefer. */
		return host;
	}
}

/**
 * The host a git hook at `cwd` is handed: `scripts/lib/hook-root.sh`'s answer,
 * for a script that must agree with the hook whatever its shell inherited
 * (#3830). `hostRoot()` where `CLAUDE_PROJECT_DIR` shares this repository's
 * git common dir, so the main checkout owning it; else, in a linked worktree, the main checkout owning a common dir called
 * `.git`; else the top level. A bare repository or a git directory has no top
 * level, so that answers the working directory and says so on stderr; a
 * directory outside any repository answers `hostRoot()`'s fail-open, silently.
 *
 * Residual: a linked worktree of a bare repository cloned to a directory named
 * `.git`, or of a `--separate-git-dir` checkout whose git directory has that
 * name, answers a parent holding no working tree, as hook-root.sh does.
 * @param {string} [cwd]
 * @returns {string}
 */
function resolveCommitHost(cwd = process.cwd()) {
	const common = gitCommonDir(cwd);
	if (common === null) return hostRoot(cwd);
	const declared = process.env.CLAUDE_PROJECT_DIR;
	if (declared && gitCommonDir(declared) === common) return hostRoot(cwd);
	try {
		const gitDir = execGit(["rev-parse", "--absolute-git-dir"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (gitDir !== common && path.basename(common) === ".git")
			return deref(path.dirname(common));
		return gitTopLevel(cwd);
	} catch (e) {
		const answer = deref(cwd);
		/* Unlike hostRoot's fail-open, reportable: the error log's directory does
		 * not derive from this, and a caller's marker written under a wrong answer
		 * sits in a store the hook never reads (#3830). */
		try {
			writeFd(
				2,
				`host-root: git named no top level for ${answer}, so the commit host falls back to it, and a marker stored under it may be one the commit's hook never reads (${caught(e).message.split("\n")[0]}).\n`,
			);
		} catch {
			/* A closed stderr must not turn this fail-open into a throw. */
		}
		return answer;
	}
}

module.exports = {
	gitTopLevel,
	hostRoot,
	resolveCommitHost,
	sessionTree,
	worktreeRoot,
};
