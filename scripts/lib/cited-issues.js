/**
 * @param {string} message
 * @returns {Set<number>}
 */
function citedIssues(message) {
	const out = new Set();
	for (const m of message.matchAll(/(?<![\w/#-])#(\d+)(?!\d)/g))
		out.add(Number(m[1]));
	return out;
}

module.exports = { citedIssues };
