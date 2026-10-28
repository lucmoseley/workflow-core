/*
 * atomic-write.js — the one temp-file-and-rename writer (#2085).
 *
 * rename(2) within one directory is atomic, so a concurrent reader sees the
 * old file or the new one, never a torn write.
 *
 * The aside is `<file>.<pid>.<hex>.tmp`: the pid separates processes, so the
 * 4 random bytes only separate calls within one, and `wx` refuses the rare
 * clash rather than share an aside. A writer killed between the two steps
 * leaves its aside behind. The sweeps of lib/oracle-cache.js,
 * lib/write-set-cache.js and the arbiter's bases, snapshots and prefixed
 * session markers collect it there; anywhere else it stays.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/**
 * @typedef {object} AtomicWriteOptions
 * @property {boolean} [mkdir] create the target's directory first
 * @property {number} [mode] the file's permission bits, applied to the aside
 *   before the rename, so the target never holds the bytes under looser ones
 * @property {(aside: string) => void} [beforeRename] runs on the aside once it
 *   is whole and before the rename
 */

/**
 * The aside `file` is written to before its rename.
 * @param {string} file
 * @param {number | string} pid
 * @param {string} tag the call's 8 random hex digits
 * @returns {string}
 */
function asidePath(file, pid, tag) {
	return `${file}.${pid}.${tag}.tmp`;
}

/**
 * The pid in `name` where it is an aside of the file named `base` in the same
 * directory, writeFileAtomic's 8-hex-digit tag and all, else null.
 * @param {string} base
 * @param {string} name
 * @returns {number | null}
 */
function asidePid(base, name) {
	const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const m = name.match(new RegExp(`^${escaped}\\.(\\d+)\\.[0-9a-f]{8}\\.tmp$`));
	return m ? Number(m[1]) : null;
}

/**
 * Replace `file` with `data` in one step. A fault at any step removes the aside
 * and RETHROWS, leaving `file` as it was.
 * @param {string} file
 * @param {string | Buffer} data
 * @param {AtomicWriteOptions} [options]
 */
function writeFileAtomic(file, data, options = {}) {
	if (options.mkdir) fs.mkdirSync(path.dirname(file), { recursive: true });
	const aside = asidePath(
		file,
		process.pid,
		crypto.randomBytes(4).toString("hex"),
	);
	try {
		fs.writeFileSync(aside, data, { flag: "wx", mode: options.mode });
		// writeFile's mode is filtered through the umask; chmod is not.
		if (options.mode !== undefined) fs.chmodSync(aside, options.mode);
		options.beforeRename?.(aside);
		fs.renameSync(aside, file);
	} catch (e) {
		try {
			fs.rmSync(aside, { force: true });
		} catch {
			/* the write's own fault is the one to report */
		}
		throw e;
	}
}

module.exports = { asidePath, asidePid, writeFileAtomic };
