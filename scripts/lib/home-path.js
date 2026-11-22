const path = require("node:path");
const { trimEndRun } = require("./trim-run.js");

/**
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
 * @param {string} word
 * @param {string | null | undefined} home
 * @returns {string | null}
 */
const expandShellHome = (word, home) =>
	expandHome(word.replace(/^\$(HOME|\{HOME\})(?=\/|$)/, "~"), home);

module.exports = { expandHome, expandShellHome, expandTildeWord };
