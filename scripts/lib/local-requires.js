const { requiredGroup } = require("./regex-group.js");
const { stripComments } = require("./strip-comments.js");

const LOCAL_REQUIRE = /\brequire\(\s*["'](\.\.?\/[^"']+)["']\s*\)/g;

/** @param {string} text @returns {string[]} */
const localRequires = (text) =>
	[...stripComments(text).matchAll(LOCAL_REQUIRE)].map((m) =>
		requiredGroup(m, 1, LOCAL_REQUIRE),
	);

module.exports = { localRequires };
