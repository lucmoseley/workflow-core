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

const { execFileSync } = require("node:child_process");
const { gitBinary } = require("./git-binary.js");
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
 * The host repository's root.
 * @param {string} [cwd] the directory the git limb asks from
 * @returns {string}
 */
function hostRoot(cwd = process.cwd()) {
	const declared = process.env.CLAUDE_PROJECT_DIR;
	if (declared) return deref(stripSlash(declared));
	if (memo.key === cwd) return memo.value;
	let top;
	try {
		top = execFileSync(gitBinary(), ["rev-parse", "--show-toplevel"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		/* Fails open to the working directory (mantahostels#103 §6), silently: this is what
		 * the error log's own directory is derived from, so a report from here
		 * would recurse. */
		return deref(cwd);
	}
	const value = deref(top);
	memo = { key: cwd, value };
	return value;
}

module.exports = { hostRoot };
