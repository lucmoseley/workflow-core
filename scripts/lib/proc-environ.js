/*
 * proc-environ.js — one variable out of `/proc/<pid>/environ` (#3322), which
 * holds a process's environment as it was at exec, NUL-separated.
 *
 * A leaf: it depends on nothing but `fs` and `path`.
 */

const fs = require("node:fs");
const path = require("node:path");

/** The /proc `WFC_PROC`'s readers take, environ or any other file (#3500). */
const procRoot = () => process.env.WFC_PROC || "/proc";

/**
 * `key`'s value in `pid`'s environment: `{ ok: false }` where the environ
 * will not read — the process gone, or another user's — and `value: null`
 * where it reads but carries no `key`.
 * @param {number | string} pid
 * @param {string} key
 * @param {string} [proc] the /proc to read, a test's stand-in
 * @returns {{ ok: false } | { ok: true, value: string | null }}
 */
function readEnvironVar(pid, key, proc = "/proc") {
	let environ;
	try {
		environ = fs.readFileSync(path.join(proc, String(pid), "environ"), "utf8");
	} catch {
		/* Each caller says what an unreadable environ means to it. */
		return { ok: false };
	}
	const prefix = `${key}=`;
	const entry = environ.split("\0").find((e) => e.startsWith(prefix));
	return {
		ok: true,
		value: entry === undefined ? null : entry.slice(prefix.length),
	};
}

module.exports = { procRoot, readEnvironVar };
