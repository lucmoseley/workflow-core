const fs = require("node:fs");
const path = require("node:path");
const { procRoot } = require("./proc-root.js");

/**
 * @param {number | string} pid
 * @param {string[]} keys
 * @param {string} [proc]
 * @returns {{ ok: false } | { ok: true, values: Record<string, string | null> }}
 */
function readEnvironVars(pid, keys, proc = procRoot()) {
	let environ;
	try {
		environ = fs.readFileSync(path.join(proc, String(pid), "environ"), "utf8");
	} catch {
		return { ok: false };
	}
	const entries = environ.split("\0");
	/** @type {Record<string, string | null>} */
	const values = {};
	for (const key of keys) {
		const entry = entries.find((e) => e.startsWith(`${key}=`));
		values[key] = entry === undefined ? null : entry.slice(key.length + 1);
	}
	return { ok: true, values };
}

/**
 * @param {number | string} pid
 * @param {string} key
 * @param {string} [proc]
 * @returns {{ ok: false } | { ok: true, value: string | null }}
 */
function readEnvironVar(pid, key, proc = procRoot()) {
	const read = readEnvironVars(pid, [key], proc);
	return read.ok ? { ok: true, value: read.values[key] ?? null } : read;
}

module.exports = { readEnvironVar, readEnvironVars };
