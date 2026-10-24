/*
 * rule-table.js — reads a gp_rule_path_rows table back out of a guard's source
 * (workflow-core#2302), so a static reader of gp_rule ids sees the ids a call names as
 * `"${<table>[@]%% *}"`.
 *
 * A table is a literal `<table>=(` assignment of double-quoted rows,
 * "<id> <path> [<module>...]", as scripts/lib/guard-parse.sh's
 * gp_rule_path_rows reads it at run time.
 */

const { requiredGroup } = require("./regex-group.js");

/** One table row's words, `[id, path, ...modules]`.
 * @typedef {[string, ...string[]]} TableRow */

/**
 * A table's ids spelt inside a gp_rule call. The lookbehind holds it to a call,
 * minified or not.
 */
const TABLE_IDS_RE =
	/(?<=(?<![\w-])gp_rule(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|)]+))*[ \t]+)"\$\{([a-z_][a-z0-9_]*)\[@\]%% \*\}"/g;

/** A table it cannot read, named with the reason. */
class RuleTableError extends Error {
	/** @param {string} message */
	constructor(message) {
		super(message);
		this.name = "RuleTableError";
	}
}

/**
 * The rows of the table `name`, each split into its words; comments between
 * rows are skipped, and the minified one-line form reads the same.
 *
 * @param {string} text
 * @param {string} name
 * @returns {TableRow[]}
 * @throws {RuleTableError} where no literal assignment holds only quoted rows
 */
function tableRows(text, name) {
	const open = new RegExp(`(?<![\\w-])${name}=\\(`).exec(text);
	if (!open)
		throw new RuleTableError(
			`no literal ${name}=( assignment for its gp_rule expansion`,
		);
	/** @type {TableRow[]} */
	const rows = [];
	const token = /\s+|#[^\n]*|"([^"]*)"|(\))/y;
	token.lastIndex = open.index + open[0].length;
	for (let m = token.exec(text); m; m = token.exec(text)) {
		if (m[2]) return rows;
		/* Unchecked cast: split always yields at least one word. */
		if (m[1] !== undefined)
			rows.push(/** @type {TableRow} */ (m[1].trim().split(/\s+/)));
	}
	throw new RuleTableError(
		`${name}=( holds something other than double-quoted rows`,
	);
}

/**
 * `text` with each table expansion in a gp_rule call replaced by the table's
 * ids, on the same line, so a line a reader reports stays true.
 *
 * @param {string} text a guard's source, or its minified code
 * @returns {string}
 * @throws {RuleTableError} rather than drop the ids, which would end the
 *   call's id run there and lose every id after it too
 */
function expandRuleTables(text) {
	return text.replace(TABLE_IDS_RE, (_, name) =>
		tableRows(text, name)
			.map((row) => row[0])
			.join(" "),
	);
}

/**
 * Every row of every table a gp_rule call in `text` expands.
 *
 * @param {string} text
 * @returns {TableRow[]}
 * @throws {RuleTableError}
 */
function ruleTableRows(text) {
	const names = new Set(
		[...text.matchAll(TABLE_IDS_RE)].map((m) =>
			requiredGroup(m, 1, TABLE_IDS_RE),
		),
	);
	return [...names].flatMap((name) => tableRows(text, name));
}

module.exports = { RuleTableError, expandRuleTables, ruleTableRows };
