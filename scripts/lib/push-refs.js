const ZERO = /^0+$/;

/** @param {string} sha */
const isZeroSha = (sha) => ZERO.test(sha);

/**
 * @typedef {{ localRef: string, sha: string, remoteRef: string | undefined, remoteSha: string | undefined }} RefLine
 */

/**
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
