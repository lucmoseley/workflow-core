const fs = require("node:fs");
const path = require("node:path");
const { procRoot } = require("./proc-root.js");

/**
 * @param {number | string} pid
 * @param {string} [proc]
 * @returns {{ ok: false } | { ok: true, env: Record<string, string> }}
 */
function readEnviron(pid, proc = procRoot()) {
	let environ;
	try {
		environ = fs.readFileSync(path.join(proc, String(pid), "environ"), "utf8");
	} catch {
		return { ok: false };
	}
	/** @type {Record<string, string>} */
	const env = {};
	for (const entry of environ.split("\0")) {
		const eq = entry.indexOf("=");
		if (eq <= 0) continue;
		const key = entry.slice(0, eq);
		if (!Object.hasOwn(env, key)) env[key] = entry.slice(eq + 1);
	}
	return { ok: true, env };
}

/**
 * @param {number | string} pid
 * @param {string[]} keys
 * @param {string} [proc]
 * @returns {{ ok: false } | { ok: true, values: Record<string, string | null> }}
 */
function readEnvironVars(pid, keys, proc = procRoot()) {
	const read = readEnviron(pid, proc);
	if (!read.ok) return read;
	/** @type {Record<string, string | null>} */
	const values = {};
	for (const key of keys)
		values[key] = Object.hasOwn(read.env, key) ? (read.env[key] ?? null) : null;
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

module.exports = { readEnviron, readEnvironVar, readEnvironVars };
