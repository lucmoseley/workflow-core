const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");

/** @typedef {Map<string, string|null>} ContentIds */

const ABSENT = "absent";

/**
 * @param {ContentIds} ids
 * @returns {ContentIds}
 */
const absentAsId = (ids) =>
	new Map([...ids].map(([p, id]) => [p, id ?? ABSENT]));

/**
 * @param {string[]} paths
 * @param {ContentIds} then
 * @param {ContentIds} now
 * @returns {boolean}
 */
function isSameContent(paths, then, now) {
	if (paths.length === 0) return false;
	return paths.every(
		(p) => then.has(p) && now.has(p) && then.get(p) === now.get(p),
	);
}

/**
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
 * @param {(args: string[], input: string) => string} hashObjects
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
		} catch (e) {
			const { code } = caught(e);
			if (code === "ENOENT" || code === "ENOTDIR") ids.set(p, null);
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

// guess, #5529
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

module.exports = {
	ABSENT,
	absentAsId,
	readTreeIds,
	readWorkingIds,
	isSameContent,
};
