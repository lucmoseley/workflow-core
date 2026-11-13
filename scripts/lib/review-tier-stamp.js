/*
 * review-tier-stamp.js — the review hold's stamp: the file in the git
 * directory through which scripts/review-hold-gate.js hands a passed commit's
 * `Review-Tier:` value to scripts/review-tier-trailer.js (#3664). One per
 * session, as a shared tree's git directory serves every session's commits at
 * once (#3906). Its first line is the tree the hold passed, its second the
 * trailer's value or `unheld`.
 */

const fs = require("node:fs");
const path = require("node:path");

const PREFIX = "wfc-review-tier-";

/** A day, far past any commit's gates: a guess, never measured. */
const STALE_MS = 24 * 60 * 60 * 1000;

/**
 * This session's stamp in `gitDir`, or null with no session, which leaves no
 * stamp. The session id's every character outside `[A-Za-z0-9_-]` becomes
 * `_`, so no id reaches outside the git directory.
 * @param {string} gitDir
 * @param {string | undefined} sessionId
 * @returns {string | null}
 */
function reviewTierStamp(gitDir, sessionId) {
	if (!sessionId) return null;
	return path.join(gitDir, PREFIX + sessionId.replace(/[^A-Za-z0-9_-]/g, "_"));
}

/**
 * Removes the stamps in `gitDir` over a day old, which dead sessions
 * stranded. Throws where the directory will not list.
 * @param {string} gitDir
 * @param {number} now epoch milliseconds
 */
function sweepReviewTierStamps(gitDir, now) {
	for (const name of fs.readdirSync(gitDir)) {
		if (!name.startsWith(PREFIX)) continue;
		const file = path.join(gitDir, name);
		try {
			if (now - fs.statSync(file).mtimeMs > STALE_MS)
				fs.rmSync(file, { force: true });
		} catch {
			/* Gone under the sweep, or a neighbour's: the next sweep retries. */
		}
	}
}

module.exports = { reviewTierStamp, sweepReviewTierStamps };
