/*
 * cited-issues.js — the issue numbers a commit message cites in this repo's
 * bare `#<n>` form (#2404). A number qualified by a repo (`mantahostels#12`) or a path is not
 * this repo's, and is left out.
 */

/** Every issue number `message` cites, in the order first cited.
 *  @param {string} message @returns {Set<number>} */
function citedIssues(message) {
	const out = new Set();
	for (const m of message.matchAll(/(?<![\w/#-])#(\d+)(?!\d)/g))
		out.add(Number(m[1]));
	return out;
}

module.exports = { citedIssues };
