/*
 * read-audit-paths.js — the path tests the read audit's modules share
 * (#4916). lib/read-audit-preload.js loads it into every audited process,
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

/* The git guard the suites put on every test's `PATH` (#3161): this
 * checkout's own where the audit runs from it. */
const GUARD = path.join(__dirname, "host-git-guard", "git");

/**
 * The test of whether a program, named with its links followed, is the git
 * guard: the one file `GUARD` names. A file of its name or its text
 * standing anywhere else is not the guard.
 * @param {(p: string) => string} [realpath] the preload hands in the
 *   `realpathSync` it does not wrap
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
	isNode,
	readRealTmpdir,
	repoPath,
	toPosix,
};
