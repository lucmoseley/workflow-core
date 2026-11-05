/*
 * session-name.js — the name a session's row shows, read from its transcript,
 * and the prefix that marks an overflow session's (#3701, #4395).
 *
 * The daemon writes each name a job takes, at launch (`-n`) or later through
 * its state.json, into the transcript as a `custom-title` line, and a resume
 * copy is listed under the latest one. The copy's own state.json reads no
 * name, so the transcript is the one place every session's name is read from.
 */

const { readJsonl } = require("./jsonl.js");

/* dispatch-sessions.sh's and name-issue-session.sh's. */
const OVERFLOW_PREFIX = "Overflow · ";

/**
 * The latest `custom-title` in transcript `file`; null where it has none or
 * will not read, since a name is never worth failing the act that wants it.
 * @param {string} file
 * @returns {string|null}
 */
function readSessionName(file) {
	let read;
	try {
		read = readJsonl(file, (line) => line.includes('"custom-title"'));
	} catch {
		return null;
	}
	const named = (read?.rows ?? []).filter(
		(r) => r.type === "custom-title" && typeof r.customTitle === "string",
	);
	return /** @type {string|undefined} */ (named.at(-1)?.customTitle) || null;
}

module.exports = { OVERFLOW_PREFIX, readSessionName };
