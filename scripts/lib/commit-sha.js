/*
 * commit-sha.js — the one probe for "does <rev> name a commit" (#2090). Any
 * directory inside the work tree answers alike as `root`.
 *
 * A git that will not run, or passes gitRead's timeout, answers null, the same
 * as a rev naming no commit, so a caller's "names no commit" message covers
 * both. Callers that must tell a broken apparatus from a missing ref
 * (lib/citation-tracker.js's `baselineCommit`) keep their own read.
 */

const { execFileSync } = require("node:child_process");
const { gitRead } = require("./dirty-tree.js");

/** @typedef {import("./dirty-tree.js").ExecFn} ExecFn */

/** A full object name, SHA-1 or SHA-256, as `git rev-parse` prints one. */
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The full sha `rev` names, or null where it names no commit.
 * @param {string} root
 * @param {string} rev
 * @param {ExecFn} [execFn]
 * @returns {string|null}
 */
function commitSha(root, rev, execFn = execFileSync) {
	const out = gitRead(
		["rev-parse", "--verify", "--quiet", `${rev}^{commit}`],
		root,
		execFn,
	);
	const sha = (out ?? "").trim();
	return FULL_SHA.test(sha) ? sha : null;
}

/**
 * @param {string} root
 * @param {string} rev
 */
const isCommit = (root, rev) => commitSha(root, rev) !== null;

module.exports = { FULL_SHA, commitSha, isCommit };
