/*
 * deref.js — a path with its symlinks resolved, for every caller that compares
 * paths: one directory reached through two symlinked spellings is one
 * directory (workflow-core#1788, the plugin-gap check reading one install through two
 * config dirs as two).
 *
 * Never throws, since a hook has no reader to throw to. A path that cannot be
 * resolved comes back as given: a root that does not exist yet is still the
 * caller's answer, and kept literally it reaches a caller whose own read
 * reports the refusal (workflow-core#1054). A caller wanting an absolute fallback calls
 * realKey.
 */

const fs = require("node:fs");
const path = require("node:path");

/**
 * @param {string} p
 * @returns {string}
 */
function deref(p) {
	try {
		return fs.realpathSync(p);
	} catch {
		// Kept as given: see the header (workflow-core#1054).
		return p;
	}
}

/**
 * The key two spellings of one directory share: absolute, symlinks resolved
 * where they resolve, so a config dir symlinked at another counts once.
 * @param {string} dir
 */
const realKey = (dir) => deref(path.resolve(dir));

module.exports = { deref, realKey };
