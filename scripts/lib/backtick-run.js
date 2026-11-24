/**
 * @param {string} line
 * @param {number} at
 * @returns {number}
 */
function runEnd(line, at) {
	let end = at;
	while (line[end] === "`") end++;
	return end;
}

module.exports = { runEnd };
