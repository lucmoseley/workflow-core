/*
 * hook-limits.js — the harness's limits on what a hook hands the session
 * (#1746).
 *
 * READ BY LINE TOO: check-injector-margin.sh, check-context-budget.js and
 * lib/rule-emission.js read a revision's or a planted copy without running
 * it: the two Node readers through limitIn(), the shell one through sed. Keep
 * each a `const NAME = <n>;` line at column zero.
 */

const { escapeRe } = require("./regex-group.js");

/* additionalContext over this many characters is persisted to a file and the
 * session handed a ~2 KB preview (mantahostels#1762). Read out of the shipped
 * binary by mantahostels#1868, so it models a consumer the repo
 * does not own and can move unnoticed. */
const HOOK_PERSIST_CHARS = 10_000;

/* The bytes of rule text one hook delivery may carry: 40% of
 * HOOK_PERSIST_CHARS. The 40% is a judgement, not a measurement: it leaves
 * room for the guard's own warn text and for a second hook on the same event. */
const RULE_CAP = 4000;

/**
 * The integer a `const <name> = <n>;` line at column zero of `source`
 * assigns, or null where none does. Biome writes `<n>` with numeric
 * separators, so `10_000` reads as 10000.
 * @param {string} source a hook-limits.js text
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
