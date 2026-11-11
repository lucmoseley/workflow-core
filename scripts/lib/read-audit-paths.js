/*
 * read-audit-paths.js — the path tests, limits and git and environment
 * readings the read audit's modules share (#4916). lib/read-audit-preload.js loads it into every audited process,
 * so it requires nothing beside Node's own modules and lib/is-under.js,
 * which the preload loads already.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { relativeUnder } = require("./is-under.js");

/**
 * Whether `file` runs Node: this process's own binary, or one of its name.
 * @param {string} file
 */
const isNode = (file) =>
	file === process.execPath || path.basename(file) === "node";

/** @param {string} p */
const toPosix = (p) => p.split(path.sep).join("/");

/**
 * `abs` repo-relative, with POSIX separators, where it lies under `root`
 * outside every `node_modules`; else null.
 * @param {string} root
 * @param {string} abs
 * @returns {string|null}
 */
function repoPath(root, abs) {
	const rel = relativeUnder(root, abs);
	if (rel === null) return null;
	const posix = toPosix(rel || ".");
	return posix.split("/").includes("node_modules") ? null : posix;
}

/**
 * The temporary directory with its links followed.
 * @param {(p: string) => string} [realpath] the preload hands in the
 *   `realpathSync` it does not wrap
 */
const readRealTmpdir = (realpath = fs.realpathSync) => realpath(os.tmpdir());

/* Linux's PATH_MAX: a longer piece is no path the kernel would take. */
const PATH_MAX = 4096;

/* How much of a call a doubt line quotes: a guess, long enough to name the
 * call, short enough to keep the cached-run banner readable. */
const SHOWN_MAX = 200;

/**
 * The value an environment's pairs give `name`; undefined where they set
 * none.
 * @param {unknown} envPairs
 * @param {string} name
 * @returns {string|undefined}
 */
function pairValue(envPairs, name) {
	if (!Array.isArray(envPairs)) return;
	const pair = envPairs.find(
		(e) => typeof e === "string" && e.startsWith(`${name}=`),
	);
	return pair === undefined ? undefined : String(pair).slice(name.length + 1);
}

/* git's options before the subcommand that take the next word as a value. */
const GIT_VALUED = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--config-env",
	"--attr-source",
]);

/* The git guard the suites put on every test's `PATH` (#3161). */
const GUARD = path.join(__dirname, "host-git-guard", "git");

/**
 * The test of whether a program, named with its links followed, is the git
 * guard: the one file `GUARD` names.
 * @param {(p: string) => string} [realpath] as `readRealTmpdir`'s
 * @returns {(real: string|undefined) => boolean}
 */
function buildGuardTest(realpath = fs.realpathSync) {
	/** @type {string|null} */
	let guard = null;
	try {
		guard = realpath(GUARD);
	} catch {
		// No guard stands beside this library, so no program is it (#4790).
	}
	return (real) => real === guard;
}

module.exports = {
	buildGuardTest,
	GIT_VALUED,
	GUARD,
	isNode,
	PATH_MAX,
	pairValue,
	readRealTmpdir,
	repoPath,
	SHOWN_MAX,
	toPosix,
};
