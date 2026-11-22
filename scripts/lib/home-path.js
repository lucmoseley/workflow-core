/*
 * home-path.js — the one reading of a leading `~` against a home directory
 * (workflow-core#4611). Six sites once spelt it their own way and disagreed on an unset or
 * relative HOME. `expandHome` wants an absolute path or nothing, and each caller
 * decides what nothing means to it; `expandTildeWord` reads a shell word as
 * bash will run it; `expandShellHome` reads `$HOME` as `~` too.
 */

const path = require("node:path");
const { trimEndRun } = require("./trim-run.js");

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
	return trimEndRun(home, "/") + p.slice(1) || "/";
}

/**
 * A shell word's leading `~` as bash expands it: against any set HOME, empty
 * or relative included, so a guard reads the path the command will. Null
 * where HOME is unset, or for `~user`, which is never looked up.
 *
 * @param {string} word
 * @param {string | null | undefined} home
 * @returns {string | null}
 */
function expandTildeWord(word, home) {
	if (!word.startsWith("~")) return word;
	if (word !== "~" && !word.startsWith("~/")) return null;
	return home == null ? null : home + word.slice(1);
}

/**
 * A shell word's leading `~`, `$HOME` or `${HOME}` read as expandHome reads a
 * `~`: an alias line names home either way (workflow-core#5293).
 *
 * @param {string} word
 * @param {string | null | undefined} home
 * @returns {string | null}
 */
const expandShellHome = (word, home) =>
	expandHome(word.replace(/^\$(HOME|\{HOME\})(?=\/|$)/, "~"), home);

module.exports = { expandHome, expandShellHome, expandTildeWord };
