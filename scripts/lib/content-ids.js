/*
 * content-ids.js — the one judge of "same content" (#3624, #4790): whether
 * every path a recorded verdict read holds the content it held then. The
 * already-red classifier asks it of a red run's tree against a base; the pass
 * store (lib/pass-store.js) asks it of a recorded file result against the
 * working tree.
 *
 * A CONTENT ID is a path's mode and blob id, as `git ls-tree` prints them, or
 * null where the path holds no file. Mode is in it because a spawned script
 * runs on its executable bit.
 */

const fs = require("node:fs");
const path = require("node:path");

/** @typedef {Map<string, string|null>} ContentIds path to content id, null where absent */

/**
 * Whether `paths` is non-empty and each path's id in `now` equals its id in
 * `then`. A path either map does not answer for holds nothing.
 * @param {string[]} paths
 * @param {ContentIds} then
 * @param {ContentIds} now
 * @returns {boolean}
 */
function sameContent(paths, then, now) {
	if (paths.length === 0) return false;
	return paths.every(
		(p) => then.has(p) && now.has(p) && then.get(p) === now.get(p),
	);
}

/**
 * Each path's content id in `treeish`, null where the tree holds no file
 * there. Throws where git does.
 * @param {(args: string[]) => string} git
 * @param {string} treeish
 * @param {string[]} paths
 * @returns {ContentIds}
 */
function readTreeIds(git, treeish, paths) {
	/** @type {ContentIds} */
	const ids = new Map(paths.map((p) => [p, null]));
	for (const chunk of chunks([...new Set(paths)]))
		for (const entry of git(["ls-tree", "-r", "-z", treeish, "--", ...chunk])
			.split("\0")
			.filter(Boolean)) {
			const tab = entry.indexOf("\t");
			const [mode, , id] = entry.slice(0, tab).split(" ");
			const p = entry.slice(tab + 1);
			if (ids.has(p)) ids.set(p, `${mode} ${id}`);
		}
	return ids;
}

/**
 * Each path's content id in the working tree at `root`, null where no regular
 * file stands there. A symlink is left unanswered, holding nothing. Throws
 * where git does.
 * @param {(args: string[], input: string) => string} hashObjects
 *   `git hash-object --stdin-paths` in `root`, handed the paths on stdin
 * @param {string} root
 * @param {string[]} paths
 * @returns {ContentIds}
 */
function readWorkingIds(hashObjects, root, paths) {
	/** @type {ContentIds} */
	const ids = new Map();
	/** @type {{p: string, mode: string}[]} */
	const files = [];
	for (const p of new Set(paths)) {
		let stat;
		try {
			stat = fs.lstatSync(path.join(root, p));
		} catch {
			ids.set(p, null);
			continue;
		}
		if (stat.isFile())
			files.push({ p, mode: stat.mode & 0o111 ? "100755" : "100644" });
		else if (!stat.isSymbolicLink()) ids.set(p, null);
	}
	for (const chunk of chunks(files)) {
		const hashed = hashObjects(
			["hash-object", "--stdin-paths"],
			`${chunk.map((f) => f.p).join("\n")}\n`,
		)
			.split("\n")
			.filter(Boolean);
		chunk.forEach((f, i) => {
			if (hashed[i]) ids.set(f.p, `${f.mode} ${hashed[i]}`);
		});
	}
	return ids;
}

/* Paths per git call, below any argv limit. Untraced: chosen, not measured. */
const CHUNK = 500;

/**
 * @template T
 * @param {T[]} list
 * @returns {T[][]}
 */
function chunks(list) {
	const out = [];
	for (let i = 0; i < list.length; i += CHUNK)
		out.push(list.slice(i, i + CHUNK));
	return out;
}

module.exports = { readTreeIds, readWorkingIds, sameContent };
