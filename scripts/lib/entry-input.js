/*
 * entry-input.js — a Node entry's payload read and fail-open logger, apart
 * from lib/guard-entry.js's kit: an entry that may find nothing to do, such as
 * record-divergence.js on every git call, pays none of the kit's loads before
 * it knows (#2899).
 */

const fs = require("node:fs");

/**
 * gl_log, its records naming `name`: the entry's file, or a dispatcher core's
 * own name.
 * @param {string} name
 * @param {string} [root] the host root the entry resolved, as logError takes it
 * @returns {(what: string, detail?: string) => void}
 */
function logger(name, root) {
	return (what, detail) => {
		try {
			require("./arbiter-core.js").logError(
				name,
				what,
				detail?.replaceAll("\x01", ""),
				root,
			);
		} catch {
			/* A log that cannot be written must not break the guard. */
		}
	};
}

/**
 * The hook payload off stdin, parsed. Null where there is none, which
 * is allowed unrecorded, or where it is not JSON, logged.
 * @param {string} noun what goes unchecked, for the record
 * @param {(what: string, detail?: string) => void} log
 * @returns {Record<string, unknown> | null}
 */
function readPayload(noun, log) {
	let raw;
	try {
		raw = fs.readFileSync(0, "utf8");
	} catch {
		raw = "";
	}
	if (!raw) return null;
	try {
		return JSON.parse(raw);
	} catch {
		log(`payload did not parse as JSON — ${noun} allowed unchecked`);
		return null;
	}
}

module.exports = { logger, readPayload };
