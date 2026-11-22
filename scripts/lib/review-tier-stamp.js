const fs = require("node:fs");
const path = require("node:path");
const { ignoreFailure } = require("./caught.js");

const PREFIX = "wfc-review-tier-";

// guess, #3906
const STALE_MS = 24 * 60 * 60 * 1000;

/**
 * @param {string} gitDir
 * @param {string | undefined} sessionId
 * @returns {string | null}
 */
function reviewTierStamp(gitDir, sessionId) {
	if (!sessionId) return null;
	return path.join(gitDir, PREFIX + sessionId.replace(/[^A-Za-z0-9_-]/g, "_"));
}

/**
 * @param {string} gitDir
 * @param {number} now
 */
function sweepReviewTierStamps(gitDir, now) {
	for (const name of fs.readdirSync(gitDir)) {
		if (!name.startsWith(PREFIX)) continue;
		const file = path.join(gitDir, name);
		ignoreFailure(() => {
			if (now - fs.statSync(file).mtimeMs > STALE_MS)
				fs.rmSync(file, { force: true });
		});
	}
}

module.exports = { reviewTierStamp, sweepReviewTierStamps };
