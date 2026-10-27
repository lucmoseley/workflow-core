/*
 * commit-sha.js — the probes for "does <rev> name a commit" (#2090). Any
 * directory inside the work tree answers alike as `root`.
 *
 * `commitSha` folds a git that will not run, or passes gitRead's timeout, into
 * null, the same as a rev naming no commit. `readCommit` keeps that failure
 * apart as `ok: false`, for a caller that must not read it as "no commit"
 * (#2864).
 */

const { execFileSync } = require("node:child_process");
const { gitRead } = require("./dirty-tree.js");
const { spawnGitSync, GIT_TIMEOUT_MS } = require("./git.js");

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

/**
 * The full sha `rev` names, null where it names none, or `ok: false` where git
 * would not answer: `rev-parse --verify --quiet` exits 1 on a rev naming no
 * commit, an unborn HEAD's among them, and any other way on a git that failed.
 * An exit 1 stands as "no commit" only once `rev-parse --git-dir` answers.
 * @param {string} root
 * @param {string} rev
 * @returns {{ ok: true, sha: string | null } | { ok: false, why: string }}
 */
function readCommit(root, rev) {
	/** @param {string[]} args */
	const rp = (args) =>
		spawnGitSync(["rev-parse", ...args], {
			cwd: root,
			encoding: "utf8",
			timeout: GIT_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "pipe"],
		});
	let r = rp(["--verify", "--quiet", `${rev}^{commit}`]);
	if (r.status === 1) {
		r = rp(["--git-dir"]);
		if (r.status === 0) return { ok: true, sha: null };
	}
	const sha = (r.stdout ?? "").trim();
	if (r.status === 0 && FULL_SHA.test(sha)) return { ok: true, sha };
	const why =
		r.error?.message ||
		(r.stderr ?? "").trim() ||
		`exited ${r.status ?? r.signal}`;
	return { ok: false, why };
}

module.exports = { FULL_SHA, commitSha, isCommit, readCommit };
