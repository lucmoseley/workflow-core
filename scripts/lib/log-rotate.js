/*
 * log-rotate.js — move an oversized log aside, keeping one generation.
 *
 * Split out of check-guard-errors.js at mantahostels#206. The fs is an argument, so the two
 * races below can be arranged directly by a test.
 *
 * IT REPORTS, IT DOES NOT WARN. The failure path returns a message and the
 * caller decides what that is.
 */

const nodeFs = require("node:fs");
const { caught } = require("./caught.js");

/*
 * Rotate once the log passes this, keeping one generation aside — mantahostels#181, which
 * ruled the policy against trimming in place and by age.
 *
 * Nothing else bounds it: the guards only ever append, and every one on the Bash
 * matcher runs on EVERY Bash call, so one persistent fail-open writes a line per
 * guard per call across 10-12 sessions — measured at ~690 KB/day against
 * ~1.3 KB/day at rest.
 *
 * THE LIMIT IS MEMORY, NOT THE HOOK'S 10s TIMEOUT. Reading the log costs about
 * 7x its size resident (measured: 105 MB read peaked at 710 MB), so the timeout
 * is not reached until ~600 MB while this machine, running a dozen sessions, is
 * in earlyoom territory long before that. 8 MB holds the read near 57 MB and
 * 0.15s — years at the resting rate, ~12 days of an unfixed runaway.
 */
const DEFAULT_ROTATE_AT = 8 * 1024 * 1024;

/**
 * WFC_ROTATE_AT is for tests only — otherwise each case writes an 8 MB log,
 * on a memory-capped machine with a parallel suite.
 */
function rotateAt(env = process.env) {
	const override = Number(env.WFC_ROTATE_AT);
	return Number.isFinite(override) && override > 0
		? override
		: DEFAULT_ROTATE_AT;
}

/**
 * Rename an oversized log to `<path>.1`, replacing the generation already there.
 * Returns null when there is nothing to say, or the reason it could not be done.
 *
 * `readSize` is what the caller read, not what is on disk now — the two differing
 * is itself one of the cases below.
 *
 * RENAME, NOT TRIM. rename(2) is one atomic syscall, so it cannot tear a record
 * or lose a line to a guard appending mid-operation — a read-modify-write would
 * drop exactly the line worth keeping.
 *
 * @param {string} logPath
 * @param {number} readSize
 * @param {{ fs?: typeof nodeFs, limit?: number }} [options]
 */
function rotateLog(
	logPath,
	readSize,
	{ fs = nodeFs, limit = rotateAt() } = {},
) {
	if (readSize <= limit) return null;
	try {
		// Grown since the read means the tail is bytes the caller never parsed, and
		// renaming would carry them off unreported. Leave it; the next run rotates
		// instead.
		if (fs.statSync(logPath).size !== readSize) return null;
		fs.renameSync(logPath, `${logPath}.1`);
		return null;
	} catch (e) {
		// Gone between the stat and the rename means another of the 10-12 concurrent
		// sessions rotated it first — warning would have several of them each
		// announce a bound that held.
		const err = caught(e);
		if (err.code === "ENOENT") return null;
		return `${logPath} is ${readSize} bytes and could not be rotated (${err.code || err.message}) — it is read whole at every session start, and nothing is bounding its growth`;
	}
}

// DEFAULT_ROTATE_AT and rotateAt have no caller outside this file: rotateLog is
// the whole production interface. Both are exported so the limit can be asserted
// as itself rather than inferred from which sizes happen to rotate.
module.exports = { DEFAULT_ROTATE_AT, rotateAt, rotateLog };
