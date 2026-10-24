/*
 * push-refs.js — the ref lines git feeds a pre-push hook on stdin, read once
 * for every checker the hook runs (#857).
 *
 * git writes `<local ref> <local sha> <remote ref> <remote sha>` per ref. A
 * delete pushes the all-zero local sha and has no bytes to check, so it is
 * dropped; a new branch carries the all-zero remote sha, kept for the caller to
 * read as "no remote tip".
 */

const ZERO = /^0+$/;

/**
 * The pushes git is being asked to make — `{ sha, remote }` per local sha,
 * repeats collapsed onto the first line that named them. `skipTags` drops a
 * line landing on `refs/tags/` before the collapse, so a branch pushed at the
 * same sha is still returned.
 * @param {string} stdin
 * @param {{ skipTags?: boolean }} [options]
 */
function pushesFrom(stdin, { skipTags = false } = {}) {
	/** @type {Array<{ sha: string, remote: string | undefined }>} */
	const out = [];
	for (const line of stdin.split("\n")) {
		const [, sha, remoteRef, remote] = line.trim().split(/\s+/);
		if (skipTags && remoteRef?.startsWith("refs/tags/")) continue;
		if (sha && !ZERO.test(sha) && !out.some((p) => p.sha === sha))
			out.push({ sha, remote });
	}
	return out;
}

module.exports = { ZERO, pushesFrom };
