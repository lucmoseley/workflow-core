/**
 * `text` less its trailing newlines, as a shell's `$(…)` reads a command's
 * output.
 * @param {string} text
 */
function stripNewlines(text) {
	let end = text.length;
	while (end > 0 && text[end - 1] === "\n") end--;
	return text.slice(0, end);
}

module.exports = { stripNewlines };
