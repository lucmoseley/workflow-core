/*
 * cut-at.js — a string split at its first separator, as two strings (workflow-core#1344).
 *
 * `s.split(sep)[0]` and `const [head, ...rest] = s.split(sep)` read as
 * `string | undefined` under `noUncheckedIndexedAccess`, though split always
 * returns one element. This returns a pair that is never short, so a caller
 * needs neither a check nor a cast.
 */

/**
 * `s` up to the first `sep`, and what follows it — "" where `s` has no `sep`.
 * @param {string} s
 * @param {string} sep
 * @returns {[string, string]}
 */
function cutAt(s, sep) {
	const i = s.indexOf(sep);
	return i === -1 ? [s, ""] : [s.slice(0, i), s.slice(i + sep.length)];
}

module.exports = { cutAt };
