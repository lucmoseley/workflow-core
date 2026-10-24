/*
 * marker-root.js — where per-session hook markers, rule latches and
 * breadcrumbs live: `.claude/tmp/markers`, the sanctioned in-repo scratch
 * directory (`.gitignore`, mantahostels#2089) — not the host repo root
 * (mantahostels#3515 F8, #2).
 *
 * `scripts/lib/marker-root.sh` is the shell half; BYTE-IDENTICAL OUTPUT IS
 * THE CONSTRAINT, same as `host-root.js`/`guard-root.sh` (see host-root.js's
 * header) — change the two together.
 *
 * Rooted on `host-root.js`'s `hostRoot()`, never `__dirname` — a plugin
 * install's files live in the plugin cache, and a marker directory resolved
 * from there would write into the wrong tree entirely (mantahostels#3515).
 *
 * THE DIRECTORY IS CREATED ON READ.
 */

const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./host-root.js");

/**
 * @param {string} dir
 * @returns {string}
 */
function ensure(dir) {
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch {
		/* Swallowed (issue #2): a guard whose marker directory cannot be
		 * created still has its real job to do. The failure surfaces at the
		 * write that follows — a plain ENOENT/EACCES from that write, not
		 * from here, and the caller's own fail-open handling (if any) is
		 * what catches it. */
	}
	return dir;
}

/**
 * @param {string} [root]
 * @returns {string}
 */
const MARKERS_REL = path.join(".claude", "tmp", "markers");

function markersDir(root = hostRoot()) {
	return ensure(path.join(root, MARKERS_REL));
}

module.exports = { MARKERS_REL, markersDir };
