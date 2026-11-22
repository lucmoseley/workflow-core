/*
 * push-refs.js — the ref lines git feeds a pre-push hook on stdin, read once
 * for every checker the hook runs (workflow-core#857), and parsed by one parser for every
 * pre-push gate (workflow-core#3116).
 *
 * git writes `<local ref> <local sha> <remote ref> <remote sha>` per ref. A
 * delete pushes the all-zero local sha and has no bytes to check; a new branch
 * carries the all-zero remote sha, for the caller to read as "no remote tip".
 */

const ZERO = /^0+$/;

/**
 * Whether `sha` is git's all-zero sha: a deletion's local sha, a new ref's
 * remote one.
 * @param {string} sha
 */
const isZeroSha = (sha) => ZERO.test(sha);

/**
 * @typedef {{ localRef: string, sha: string, remoteRef: string | undefined, remoteSha: string | undefined }} RefLine
 */

/**
 * Each ref line naming a local sha, in order, deletions included.
 * @param {string} stdin
 * @returns {RefLine[]}
 */
function parseRefLines(stdin) {
	return stdin.split("\n").flatMap((line) => {
		const [localRef, sha, remoteRef, remoteSha] = line.trim().split(/\s+/);
		return localRef && sha ? [{ localRef, sha, remoteRef, remoteSha }] : [];
	});
}

/**
 * The pushes git is being asked to make — `{ sha, remoteSha }` per local sha,
 * deletions dropped and repeats collapsed onto the first line that named them.
 * `skipTags` drops a line landing on `refs/tags/` before the collapse, so a
 * branch pushed at the same sha is still returned.
 * @param {string} stdin
 * @param {{ skipTags?: boolean }} [options]
 */
function parsePushes(stdin, { skipTags = false } = {}) {
	/** @type {Array<{ sha: string, remoteSha: string | undefined }>} */
	const out = [];
	for (const { sha, remoteRef, remoteSha } of parseRefLines(stdin)) {
		if (skipTags && remoteRef?.startsWith("refs/tags/")) continue;
		if (!isZeroSha(sha) && !out.some((p) => p.sha === sha))
			out.push({ sha, remoteSha });
	}
	return out;
}

module.exports = { isZeroSha, parsePushes, parseRefLines };
