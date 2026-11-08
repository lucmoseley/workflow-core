/*
 * proc-environ.js — one variable out of `/proc/<pid>/environ` (workflow-core#3322), which
 * holds a process's environment as it was at exec, NUL-separated.
 *
 * A leaf: it depends on nothing but `fs`, `path` and lib/proc-root.js.
 */

const fs = require("node:fs");
const path = require("node:path");
const { procRoot } = require("./proc-root.js");

/**
 * Each of `keys`' values in `pid`'s environment: `{ ok: false }` where the
 * environ will not read — the process gone, or another user's — and a `null`
 * value for a key it reads without.
 * @param {number | string} pid
 * @param {string[]} keys
 * @param {string} [proc] the /proc to read, a test's stand-in
 * @returns {{ ok: false } | { ok: true, values: Record<string, string | null> }}
 */
function readEnvironVars(pid, keys, proc = procRoot()) {
	let environ;
	try {
		environ = fs.readFileSync(path.join(proc, String(pid), "environ"), "utf8");
	} catch {
		/* Each caller says what an unreadable environ means to it. */
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
 * `key`'s value in `pid`'s environment, as readEnvironVars reads it.
 * @param {number | string} pid
 * @param {string} key
 * @param {string} [proc] the /proc to read, a test's stand-in
 * @returns {{ ok: false } | { ok: true, value: string | null }}
 */
function readEnvironVar(pid, key, proc = procRoot()) {
	const read = readEnvironVars(pid, [key], proc);
	return read.ok ? { ok: true, value: read.values[key] ?? null } : read;
}

module.exports = { readEnvironVar, readEnvironVars };
