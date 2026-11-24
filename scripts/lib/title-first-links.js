const { requiredGroup } = require("./regex-group");

/** @param {string} repo */
const issueLinkPattern = (repo) =>
	new RegExp(
		`\\[([^\\]]*)\\]\\(https://github\\.com/${repo.replace("/", "\\/")}/issues/(\\d+)(#[^)]*)?\\)`,
		"g",
	);

const LEADS_WITH_NUMBER = /^\s*#\d+/;

/**
 * @param {string} text
 * @param {string} repo
 * @returns {Array<{ target: number, linkText: string }>}
 */
function titleFirstLinks(text, repo) {
	const issueLink = issueLinkPattern(repo);
	const found = [];
	for (const m of text.matchAll(issueLink)) {
		const linkText = requiredGroup(m, 1, issueLink);
		if (LEADS_WITH_NUMBER.test(linkText)) continue;
		found.push({
			target: Number(requiredGroup(m, 2, issueLink)),
			linkText: linkText.slice(0, 80),
		});
	}
	return found;
}

module.exports = { titleFirstLinks };
