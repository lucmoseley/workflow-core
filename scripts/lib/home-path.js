/*
 * home-path.js — the one reading of a leading `~` against a home directory
 * (#4611). Six sites once spelt it their own way and disagreed on an unset or
 * relative HOME; here an unknown home is null, and each caller decides what an
 * unknown path means to it.
 */

const path = require("node:path");

/**
 * A leading `~` or `~/` read against `home`, concatenated as the shell does and
 * never normalised: a shell word may still hold masked spans or unexpanded
 * variables, so folding a `..` here would drop segments that later expand.
 * Any other path, `~user` included, comes back as written. Null where there is
 * a tilde to expand but `home` is unset, empty or relative.
 *
 * @param {string} p
 * @param {string | null | undefined} home
 * @returns {string | null}
 */
function expandHome(p, home) {
	if (p !== "~" && !p.startsWith("~/")) return p;
	if (!home || !path.isAbsolute(home)) return null;
	return home.replace(/\/+$/, "") + p.slice(1) || "/";
}

/**
 * A shell word's leading `~`, as a parser that never looks up `~user` reads
 * it: null for any leading `~` that will not expand, `~user` included.
 *
 * @param {string} word
 * @param {string | null | undefined} home
 * @returns {string | null}
 */
function expandTildeWord(word, home) {
	const out = expandHome(word, home);
	return word.startsWith("~") && out === word ? null : out;
}

module.exports = { expandHome, expandTildeWord };
