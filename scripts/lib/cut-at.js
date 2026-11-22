/**
 * @param {string} s
 * @param {string} sep
 * @returns {[string, string]}
 */
function cutAt(s, sep) {
	const i = s.indexOf(sep);
	return i === -1 ? [s, ""] : [s.slice(0, i), s.slice(i + sep.length)];
}

/**
 * @param {string} s
 * @param {RegExp} re
 * @returns {string}
 */
function beforeMatch(s, re) {
	const i = s.search(re);
	return i === -1 ? s : s.slice(0, i);
}

module.exports = { beforeMatch, cutAt };
