const { escapeRe } = require("./regex-group.js");

// measured 10,000 in the shipped binary, lucmoseley/mantahostels#1868
const HOOK_PERSIST_CHARS = 10_000;

// guess, 40% of HOOK_PERSIST_CHARS, lucmoseley/mantahostels#1804
const RULE_CAP = 4000;

/**
 * @param {string} source
 * @param {string} name
 * @returns {number | null}
 */
function limitIn(source, name) {
	const found = new RegExp(
		`^const ${escapeRe(name)} = (\\d[\\d_]*);$`,
		"m",
	).exec(source)?.[1];
	return found === undefined ? null : Number(found.replaceAll("_", ""));
}

module.exports = { HOOK_PERSIST_CHARS, RULE_CAP, limitIn };
