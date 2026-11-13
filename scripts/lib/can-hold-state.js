/*
 * can-hold-state.js — may this directory hold a checker's state files?
 *
 * Extracted at mantahostels#1997.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");

/**
 * Can this directory hold state — or be created to? A directory that does not
 * exist yet is fine, since the writer creates it recursively; what disqualifies
 * one is a permission bit, on the directory itself or on the nearest ancestor
 * that does exist.
 *
 * ENOENT ON A PATH THAT DOES EXIST IS A DANGLING SYMLINK, and unusable: access()
 * resolves the link, mkdirSync would throw EEXIST, and the walk would otherwise
 * pass the dir on the strength of its parent's bits.
 *
 * RESIDUAL: it answers for the directory, never for a file inside it, so an
 * unreadable file under a writable dir still defeats whatever that file is for.
 * And the answer can go stale between this check and the write, which costs a
 * repeated notice and nothing else.
 *
 * @param {string} dir
 */
function canHoldState(dir) {
	for (let at = dir; ; at = path.dirname(at)) {
		// The directory itself needs reading as well as writing; an ancestor is only
		// ever traversed and created into.
		const mode =
			at === dir
				? fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK
				: fs.constants.W_OK | fs.constants.X_OK;
		try {
			fs.accessSync(at, mode);
			return true;
		} catch (err) {
			// Anything but "not there yet" is the permission bit this test is for.
			if (caught(err).code !== "ENOENT") return false;
			if (isPresent(at)) return false;
			if (path.dirname(at) === at) return false;
		}
	}
}

/**
 * Does the path exist as an entry, a link its own target lacking included?
 * @param {string} at
 */
function isPresent(at) {
	try {
		fs.lstatSync(at);
		return true;
	} catch {
		return false;
	}
}

/**
 * `pinned` where it can hold state; else the sorted-first of `candidates` that
 * can, so every plan still agrees on one; else `pinned` anyway (mantahostels#1912).
 *
 * RESIDUAL: a fallback directory is no arbiter state directory, so the seat
 * carry (workflow-core#383) never moves what lands there, and repairing `pinned` abandons it.
 * @param {string} pinned
 * @param {string[]} candidates
 */
const pinnedOrFirstUsable = (pinned, candidates) =>
	canHoldState(pinned)
		? pinned
		: [...candidates].sort().find(canHoldState) || pinned;

module.exports = { canHoldState, pinnedOrFirstUsable };
