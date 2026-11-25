const { requiredGroup } = require("./regex-group.js");

/* Stryker v10.1.1's own directive pattern: https://github.com/stryker-mutator/stryker-js/blob/v10.1.1/packages/instrumenter/src/transformers/directive-bookkeeper.ts */
const DIRECTIVE =
	/^\s?Stryker (disable|restore)(?: (next-line))? ([a-zA-Z, ]+)(?::(.+)?)?/;

/** @typedef {{verb: string, scope: string | undefined, mutators: string[], reason: string | undefined}} ParsedDirective */

/**
 * @param {string} text
 * @returns {ParsedDirective | null}
 */
function parseStrykerDirective(text) {
	const d = DIRECTIVE.exec(text);
	if (d === null) return null;
	return {
		verb: requiredGroup(d, 1, DIRECTIVE),
		scope: d[2],
		mutators: requiredGroup(d, 3, DIRECTIVE)
			.split(",")
			.map((m) => m.trim().toLowerCase()),
		reason: d[4],
	};
}

/** @param {ParsedDirective} d */
const isUnreasonedDisable = (d) =>
	d.verb === "disable" && (d.reason === undefined || d.reason.trim() === "");

/** @param {string} value */
const directiveLineOffset = (value) => (value.startsWith("\n") ? 1 : 0);

module.exports = {
	parseStrykerDirective,
	isUnreasonedDisable,
	directiveLineOffset,
};
