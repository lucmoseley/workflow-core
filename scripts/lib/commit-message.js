/*
 * commit-message.js — a commit message file's lines as git's `strip` cleanup
 * mode leaves them, the mode for a message from the editor (#2884). A `-m`
 * message is cleaned in `whitespace` mode, which keeps `#` lines: #3075.
 *
 * Dropped:
 *   - `#`-prefixed lines: git's own template block. `#` is hard-coded, so a repository setting
 *     `core.commentChar` elsewhere has its template block kept.
 *   - everything from the scissors line (`# ------------------------ >8 …`):
 *     under `git commit --verbose` the diff sits below it UNPREFIXED, so a
 *     commit editing a rule's own text would match its own diff.
 */

const SCISSORS = /^# -+ >8 -+/;

/**
 * @param {string} raw the message file's text
 * @returns {string[]}
 */
function strippedLines(raw) {
	/** @type {string[]} */
	const kept = [];
	for (const line of raw.split("\n")) {
		if (SCISSORS.test(line)) break;
		if (!line.startsWith("#")) kept.push(line);
	}
	return kept;
}

module.exports = { strippedLines };
