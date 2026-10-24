/*
 * compaction-set.js — the per-session set of autocompactions, one boundary key
 * a line, and the sentence that reports its size. One writer for the ceiling
 * guard (#1032) and inject-compaction-count.js (#1148), so their counts agree.
 *
 * A running set rather than a fresh count, because a large transcript is read
 * from its tail and an early boundary scrolls out of it.
 *
 * RESIDUAL: `readSeen` reads an unreadable set as empty, so the next write
 * keeps only the boundaries still in the tail.
 */

const path = require("node:path");
const hookBlock = require("./hook-block");
const { markersDir } = require("./marker-root");
const { readSeen, writeSeen } = require("./report-once");

const COMPACTIONS_PREFIX = ".session-ceiling-compactions-";
/* A compaction counted before its boundary reached the transcript. */
const PENDING_PREFIX = "pending:";

/**
 * Adds `keys` to the session's set, drops every `pending:` key not among them,
 * and returns its size.
 *
 * DROPPED, NOT SETTLED ONE FOR ONE (#1785). A subagent's compaction fires both
 * hooks with its parent's session id and no `agent_id` (harness 2.1.301), so it
 * leaves a pending key no main-tier boundary will ever settle. A main
 * compaction's boundary is in the transcript by the next Stop and by the next
 * compaction, which both pass it, so a dropped key is counted again as its
 * boundary or was never the main session's.
 *
 * RESIDUAL: a subagent's `SessionStart:compact` landing between its parent's
 * own compaction hooks and that boundary's write drops the parent's key early,
 * so the set reads one low until the parent's next Stop.
 * @param {string} sid
 * @param {string[]} keys
 * @returns {number}
 */
function recordCompactions(sid, keys) {
	const file = path.join(
		markersDir(hookBlock.repoRoot()),
		COMPACTIONS_PREFIX + sid,
	);
	const seen = readSeen(file);
	const before = [...seen].join("\n");
	for (const key of seen) if (key.startsWith(PENDING_PREFIX)) seen.delete(key);
	for (const key of keys) seen.add(key);
	if ([...seen].join("\n") !== before && !writeSeen(file, seen)) {
		try {
			require("./arbiter-core").logError(
				"compaction-set",
				new Error(`unwritable: ${file}`),
			);
		} catch {
			/* A log that cannot be written must not break the hook. */
		}
	}
	return seen.size;
}

/** @param {number} count */
function compactionSentence(count) {
	const times = `${count.toLocaleString("en-GB")} time${count === 1 ? "" : "s"}`;
	return `This session has autocompacted ${times}.`;
}

/* No hand-on: compaction is the move at the ceiling (#1178 Q1 (A), #1199). */
const COMPACTION_ADVICE =
	"Finish the unit of work in flight, start no new one, and end.";

module.exports = {
	PENDING_PREFIX,
	recordCompactions,
	compactionSentence,
	COMPACTION_ADVICE,
};
