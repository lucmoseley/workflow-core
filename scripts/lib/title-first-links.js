/*
 * title-first-links.js — the markdown links to an issue in one repo whose link
 * text does not lead with `#<n>`, the number hidden in the URL (workflow-core#2265).
 */

const { requiredGroup } = require("./regex-group");

/*
 * The trailing group allows a `#issuecomment-…` fragment: `[#31's
 * verification comment](…/issues/31#…)` is a legitimate deep link and passes,
 * while the same link with a prose title in front is the fault.
 */
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
