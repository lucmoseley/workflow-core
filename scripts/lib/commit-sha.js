/*
 * commit-sha.js — the probes for "does <rev> name a commit" (#2090), all built
 * on `readCommit` (#3068). Any directory inside the work tree answers alike as
 * `root`.
 *
 * `commitSha` folds a git that will not run, or passes GIT_TIMEOUT_MS, into
 * null, the same as a rev naming no commit. `readCommit` keeps that failure
 * apart as `ok: false`, for a caller that must not read it as "no commit"
 * (#2864).
 */

const { caught } = require("./caught.js");
const {
	gitBinary,
	gitReader,
	gitSpawnOptions,
	GIT_TIMEOUT_MS,
} = require("./git.js");

/** @typedef {import("./dirty-tree.js").ExecFn} ExecFn */
/** @typedef {import("./git.js").GitReader} GitReader */

/** A full object name, SHA-1 or SHA-256, as `git rev-parse` prints one. */
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/* A guess, not a measurement: room for a 64-character sha and a few words
 * past it, kept to one line of the error. */
const PRINTED_CHARS_SHOWN = 80;

/**
 * The full sha `rev` names, null where it names none, or `ok: false` where git
 * would not answer: `rev-parse --verify --quiet` exits 1 on a rev naming no
 * commit, an unborn HEAD's among them, and any other way on a git that failed.
 * An exit 1 stands as "no commit" only once `rev-parse --git-dir` answers.
 * @param {GitReader} read
 * @param {string} rev
 * @returns {{ ok: true, sha: string | null } | { ok: false, why: string }}
 */
function readCommit(read, rev) {
	const r = read(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], [1]);
	if (!r.ok) return r;
	const sha = r.out.trim();
	if (FULL_SHA.test(sha)) return { ok: true, sha };
	if (sha)
		return {
			ok: false,
			why: `rev-parse printed ${sha.slice(0, PRINTED_CHARS_SHOWN)}`,
		};
	const repo = read(["rev-parse", "--git-dir"], []);
	return repo.ok ? { ok: true, sha: null } : repo;
}

/**
 * An execFileSync-shaped `execFn` as a GitReader: it returns stdout, and
 * throws on a non-zero exit with the exit code as `status`.
 * @param {string} root
 * @param {ExecFn} execFn
 * @returns {GitReader}
 */
const execReader = (root, execFn) => (args, noMatch) => {
	try {
		const out = execFn(
			gitBinary(),
			args,
			gitSpawnOptions({
				cwd: root,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: GIT_TIMEOUT_MS,
			}),
		);
		return { ok: true, out: String(out ?? "") };
	} catch (e) {
		const { status, message } = caught(e);
		if (status !== undefined && noMatch.includes(status))
			return { ok: true, out: "" };
		return { ok: false, why: message };
	}
};

/**
 * The full sha `rev` names, or null where it names no commit.
 * @param {string} root
 * @param {string} rev
 * @param {ExecFn} [execFn]
 * @returns {string|null}
 */
function commitSha(root, rev, execFn) {
	const r = readCommit(
		execFn ? execReader(root, execFn) : gitReader(root),
		rev,
	);
	return r.ok ? r.sha : null;
}

module.exports = { FULL_SHA, commitSha, readCommit };
