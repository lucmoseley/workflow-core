/*
 * session-name.js — the name a session's row shows, read from its transcript
 * (#4395).
 *
 * The daemon writes each name a job takes, at launch (`-n`) or later through
 * its state.json, into the transcript as a `custom-title` line, and a resume
 * copy is listed under the latest one. The copy's own state.json reads no
 * name, so the transcript is the one place every session's name is read from.
 */

const { caught } = require("./caught.js");
const { readJsonl } = require("./jsonl.js");

/**
 * The latest `custom-title` in transcript `file`, null where it has none or
 * no file; why not where the file will not read, for the caller to log and
 * fall back from, since a name never fails the act that wants it.
 * @param {string} file
 * @returns {{name: string|null}|{why: string}}
 */
function readSessionName(file) {
	let read;
	try {
		read = readJsonl(file, (line) => line.includes('"custom-title"'));
	} catch (e) {
		return { why: `reading ${file}: ${caught(e).message}` };
	}
	const named = (read?.rows ?? []).filter(
		(r) => r.type === "custom-title" && typeof r.customTitle === "string",
	);
	const name = /** @type {string|undefined} */ (named.at(-1)?.customTitle);
	return { name: name || null };
}

module.exports = { readSessionName };
