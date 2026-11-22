/** @param {string} s @param {string} chars */
function trimEndRun(s, chars) {
	let end = s.length;
	while (end > 0 && chars.includes(s.charAt(end - 1))) end--;
	return s.slice(0, end);
}

/** @param {string} s @param {string} chars */
function trimStartRun(s, chars) {
	let start = 0;
	while (start < s.length && chars.includes(s.charAt(start))) start++;
	return s.slice(start);
}

/** @param {string} s @param {string} chars */
const trimRun = (s, chars) => trimStartRun(trimEndRun(s, chars), chars);

/** @param {string} s @param {string} chars */
const endRun = (s, chars) => s.slice(trimEndRun(s, chars).length);

module.exports = { trimEndRun, trimStartRun, trimRun, endRun };
