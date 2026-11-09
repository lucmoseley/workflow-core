const path = require("node:path");

/**
 * A leading `~` or `~/` read against `home`, the result normalised. Any other
 * path, `~user` included, comes back as written. Null where there is a tilde
 * to expand but `home` is unset, empty or relative: where that lands is
 * unknowable, so each caller decides what an unknown path means to it.
 *
 * @param {string} p
 * @param {string | null | undefined} home
 * @returns {string | null}
 */
function expandHome(p, home) {
	if (p !== "~" && !p.startsWith("~/")) return p;
	if (!home || !path.isAbsolute(home)) return null;
	return path.join(home, p.slice(1));
}

module.exports = { expandHome };
