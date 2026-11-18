/*
 * filing-refused.js — the error a fix ticket's filer throws where
 * file-issue.js refuses the ticket for good, exiting 2, so a lander tells it
 * from a tracker fault a rerun can outlast (workflow-core#4485).
 */

/** A filing file-issue.js refuses for good, which no rerun files. */
class FilingRefusedError extends Error {
	/** @param {string} message */
	constructor(message) {
		super(message);
		this.name = "FilingRefusedError";
	}
}

module.exports = { FilingRefusedError };
