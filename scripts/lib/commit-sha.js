const { caught } = require("./caught.js");
const { brokenError } = require("./outcome-error.js");
const {
	gitBinary,
	gitReader,
	gitSpawnOptions,
	GIT_TIMEOUT_MS,
} = require("./git.js");

/** @typedef {import("./dirty-tree.js").ExecFn} ExecFn */
/** @typedef {import("./git.js").GitReader} GitReader */

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// guess, workflow-core#5529
const PRINTED_CHARS_SHOWN = 80;

/**
 * @param {GitReader} read
 * @param {string} rev
 * @returns {{ ok: true, sha: string | null } | { ok: false, why: string, isUnrun?: true }}
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

/**
 * @param {string} rev
 * @param {string} [root]
 * @returns {string | null}
 */
function readCommitOrBroken(rev, root) {
	const r = readCommit(gitReader(root), rev);
	if (!r.ok) {
		throw brokenError(
			`git would not resolve ${rev}: ${r.why} — run \`git rev-parse --verify ${rev}\` to see git's own error`,
		);
	}
	return r.sha;
}

module.exports = {
	FULL_SHA,
	PRINTED_CHARS_SHOWN,
	commitSha,
	readCommit,
	readCommitOrBroken,
};
