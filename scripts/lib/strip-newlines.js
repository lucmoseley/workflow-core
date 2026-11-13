/*
 * strip-newlines.js — a string less its trailing newlines, as a shell's
 * `$(…)` reads a command's output: the Node ports of the commit route and the
 * review hold compare what their shell copies read this way (#5153). A loop,
 * not `/\n+$/`, which ESLint's regexp/no-super-linear-move refuses.
 */

/**
 * @param {string} text
 */
function stripNewlines(text) {
	let end = text.length;
	while (end > 0 && text[end - 1] === "\n") end--;
	return text.slice(0, end);
}

module.exports = { stripNewlines };
