/*
 * trim-run.js — a string with a run of the given characters cut from its end,
 * its start or both, or that trailing run itself, in one linear scan. A regex such as `/\n+$/` retries from every
 * character of a run that is not at the end, so 100,000 spaces mid-input cost
 * seconds (#3383). `\s` and `String.prototype.trimEnd()` cut the same set, so
 * `/\s+$/` needs no helper; these cover the narrower sets.
 */

/**
 * @param {string} s
 * @param {string} chars every character that belongs to the run
 */
function trimEndRun(s, chars) {
	let end = s.length;
	while (end > 0 && chars.includes(s.charAt(end - 1))) end--;
	return s.slice(0, end);
}

/**
 * @param {string} s
 * @param {string} chars every character that belongs to the run
 */
function trimStartRun(s, chars) {
	let start = 0;
	while (start < s.length && chars.includes(s.charAt(start))) start++;
	return s.slice(start);
}

/**
 * `s` with the run cut from both ends.
 * @param {string} s
 * @param {string} chars every character that belongs to the run
 */
const trimRun = (s, chars) => trimStartRun(trimEndRun(s, chars), chars);

/**
 * The trailing run itself: what `trimEndRun` cuts, or "" where `s` does not
 * end in one.
 * @param {string} s
 * @param {string} chars every character that belongs to the run
 */
const endRun = (s, chars) => s.slice(trimEndRun(s, chars).length);

module.exports = { trimEndRun, trimStartRun, trimRun, endRun };
