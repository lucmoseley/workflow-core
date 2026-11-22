const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { ignoreFailure } = require("./caught.js");
const { escapeRe } = require("./regex-group.js");

/**
 * @typedef {object} AtomicWriteOptions
 * @property {boolean} [mkdir]
 * @property {number} [mode]
 * @property {(aside: string) => void} [beforeRename]
 */

/**
 * @param {string} file
 * @param {number | string} pid
 * @param {string} tag
 * @returns {string}
 */
function asidePath(file, pid, tag) {
	return `${file}.${pid}.${tag}.tmp`;
}

/**
 * @param {string} base
 * @param {string} name
 * @returns {number | null}
 */
function asidePid(base, name) {
	const escaped = escapeRe(base);
	const m = name.match(new RegExp(`^${escaped}\\.(\\d+)\\.[0-9a-f]{8}\\.tmp$`));
	return m ? Number(m[1]) : null;
}

/** @param {string} file */
const newAside = (file) =>
	asidePath(file, process.pid, crypto.randomBytes(4).toString("hex"));

/**
 * @param {string} file
 * @param {(fd: number) => void} write
 */
function writeStreamAtomic(file, write) {
	const aside = newAside(file);
	try {
		const fd = fs.openSync(aside, "wx");
		try {
			const prior = statMode(file);
			if (prior !== null) fs.fchmodSync(fd, prior);
			write(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(aside, file);
	} catch (e) {
		ignoreFailure(() => fs.rmSync(aside, { force: true }));
		throw e;
	}
}

/**
 * @param {string} file
 * @returns {number | null}
 */
function statMode(file) {
	try {
		return fs.statSync(file).mode & 0o7777;
	} catch {
		return null;
	}
}

/**
 * @param {string} file
 * @param {string | Buffer} data
 * @param {AtomicWriteOptions} [options]
 */
function writeFileAtomic(file, data, options = {}) {
	if (options.mkdir) fs.mkdirSync(path.dirname(file), { recursive: true });
	const aside = newAside(file);
	try {
		fs.writeFileSync(aside, data, { flag: "wx", mode: options.mode });
		if (options.mode !== undefined) fs.chmodSync(aside, options.mode);
		options.beforeRename?.(aside);
		fs.renameSync(aside, file);
	} catch (e) {
		ignoreFailure(() => fs.rmSync(aside, { force: true }));
		throw e;
	}
}

module.exports = { asidePath, asidePid, writeFileAtomic, writeStreamAtomic };
