/*
 * report-once.js — the half of a transcript-reading Stop guard that names a
 * tool call and tells a session about it once, for ever (#861).
 *
 * Each guard keeps its own `seen` set beside `blockStop`'s counter because the
 * two bound different things: the counter bounds how many TURNS a guard may
 * cost a session, and the set bounds how many times one tool call may be
 * mentioned.
 */

const fs = require("node:fs");
const path = require("node:path");

const { markersDir } = require("./marker-root.js");

/* A first guess, and stated as one: enough for a git or gh command line, which
 * is what almost every guarded call is, and short enough that a stanza stays
 * one screen. Nothing has measured where a longer quote starts paying. */
const INPUT_CHARS = 160;

/**
 * One line naming a tool call, its input quoted to INPUT_CHARS.
 * @param {{name?: unknown, input?: unknown} | undefined} call
 * @returns {string}
 */
function describeCall(call) {
	if (!call) return "a tool call this transcript no longer carries";
	const input = /** @type {Record<string, unknown> | null} */ (
		call.input && typeof call.input === "object" ? call.input : null
	);
	const gist =
		input && typeof input.command === "string"
			? input.command
			: JSON.stringify(call.input ?? null);
	const one = String(gist).replace(/\s+/g, " ").trim();
	const name = typeof call.name === "string" ? call.name : "?";
	return `${name}: ${one.length > INPUT_CHARS ? `${one.slice(0, INPUT_CHARS)}…` : one}`;
}

/**
 * A session's seen set, one id a line.
 * @param {string} file
 * @returns {Set<string>}
 */
function readSeen(file) {
	try {
		return new Set(fs.readFileSync(file, "utf8").split("\n").filter(Boolean));
	} catch {
		/* Fails open (mantahostels#103 §6): nothing recorded yet, or unreadable,
		 * and every id reads as unseen. */
		return new Set();
	}
}

/**
 * @param {string} file
 * @param {Set<string>} seen
 * @returns {boolean} whether the set was written
 */
function writeSeen(file, seen) {
	try {
		fs.writeFileSync(file, `${[...seen].join("\n")}\n`);
		return true;
	} catch {
		/* Fails open (mantahostels#103 §6); the caller decides what an unrecorded
		 * id costs. */
		return false;
	}
}

/**
 * Block the Stop over the items whose id this session has not been told
 * about, and mark them told. The seen set lives at `<seenPrefix><session>`.
 *
 * `block` makes the guard's own `hookBlock.blockStop` call and returns its
 * result. The call stays in the guard so `hook-block.test.ts` reads its
 * literal counter prefix.
 *
 * RECORDED ONLY WHERE THE BLOCK ACTUALLY WENT OUT. `blockStop` returns false
 * once this session has had its MAX_BLOCKS turns, and a set written before
 * that would mark an item told that the session was never shown, and drop it
 * for ever. The cost of this order is a repeated report where the process dies
 * between the two, which is bounded by the same cap.
 *
 * @template T
 * @param {{root: string, sessionId: string, seenPrefix: string, items: T[],
 *   idOf: (item: T) => string, block: (fresh: T[]) => boolean}} opts
 * @returns {boolean} whether a block was emitted
 */
function reportOnce({ root, sessionId, seenPrefix, items, idOf, block }) {
	const file = path.join(markersDir(root), seenPrefix + sessionId);
	const seen = readSeen(file);
	const fresh = items.filter((item) => !seen.has(idOf(item)));
	if (fresh.length === 0) return false;

	const emitted = block(fresh);
	if (emitted) {
		for (const item of fresh) seen.add(idOf(item));
		/* Unwritten, the call is reported again at the next Stop, which the block
		 * counter caps at MAX_BLOCKS either way. */
		writeSeen(file, seen);
	}
	return emitted;
}

module.exports = { describeCall, readSeen, reportOnce, writeSeen };
