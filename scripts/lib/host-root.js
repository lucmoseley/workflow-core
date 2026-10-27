/*
 * host-root.js — the one seam every script in the core uses to find the HOST
 * repository.
 *
 * THE CONTRACT, in order: `CLAUDE_PROJECT_DIR` where the harness sets it, else
 * the git top level of the working directory, symlinks dereferenced either way.
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

const { execGit, gitCommonDir } = require("./git.js");
const { caught } = require("./caught.js");
const { deref } = require("./deref.js");

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
 * The host repository's root.
 * @param {string} [cwd] the directory the git limb asks from
 * @param {{ timeoutMs?: number, onTimeout?: () => void }} [opts] the git
 *   limb's ceiling, none by default; a read past it fails open to the working
 *   directory like any other, and calls `onTimeout`
 * @returns {string}
 */
function hostRoot(cwd = process.cwd(), { timeoutMs, onTimeout } = {}) {
	const declared = process.env.CLAUDE_PROJECT_DIR;
	if (declared) return deref(stripSlash(declared));
	if (memo.key === cwd) return memo.value;
	let value;
	try {
		value = gitTopLevel(cwd, timeoutMs);
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
 * The tree a test run reads: the git top level of the working directory where
 * that is a linked worktree of the host repository, else `hostRoot()`.
 *
 * NOT `hostRoot()` ALONE (#2940). The harness sets `CLAUDE_PROJECT_DIR` to the
 * shared tree for every Bash call, so a run launched inside a linked worktree
 * would otherwise test the shared tree's files and say nothing. State keyed on
 * the host stays there — the arbiter's directory on `hostRoot()`, the marker
 * store on the git common dir: only which files are under test follows the
 * worktree.
 * @param {string} [cwd]
 * @returns {string}
 */
function worktreeRoot(cwd = process.cwd()) {
	const host = hostRoot(cwd);
	if (!process.env.CLAUDE_PROJECT_DIR) return host;
	let top;
	try {
		top = gitTopLevel(cwd);
	} catch {
		/* Outside any repository there is no worktree to prefer. */
		return host;
	}
	if (top === host) return host;
	const mine = gitCommonDir(cwd);
	return mine !== null && mine === gitCommonDir(host) ? top : host;
}

module.exports = { gitTopLevel, hostRoot, worktreeRoot };
