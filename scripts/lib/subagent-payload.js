/*
 * subagent-payload.js — whether a hook payload came from a subagent. The shell
 * hooks ask it through lib/subagent-payload.sh.
 *
 * A payload carrying an `agent_id` is a subagent's; the parent's never do.
 * The field reads as jq's `// ""` does, so `null`, `false` and `""` read as
 * the parent's.
 *
 * NOT ON EVERY EVENT (#1785). Harness 2.1.302 builds `PreCompact` and
 * `SessionStart:compact` without it, so a subagent's compaction reaches these
 * hooks with its parent's `session_id` and `transcript_path`.
 *
 * STOPGAP ON `SessionStart:compact` (#1837 Q3 (A)): there, the compacting side
 * is told by transcript freshness. A subagent's compaction is read where the
 * parent's transcript is over STALE_PARENT_S old and a subagent transcript
 * under it is fresher and under FRESH_SUBAGENT_S old. It misses a subagent
 * that compacts while its parent is writing.
 * Delete it once the harness sends `agent_id` on that event.
 */

const fs = require("node:fs");
const path = require("node:path");

/* 13 s over the stalest parent transcript the replay saw at the parent's own
 * compaction, 17 s. */
const STALE_PARENT_S = 30;
/* In the replay, 60 s caught 65 subagent compactions, 120 s 75, 300 s 76. */
const FRESH_SUBAGENT_S = 120;

/**
 * Seconds since `file` was last written, or null where it cannot be read.
 * @param {string} file
 */
function ageS(file) {
	try {
		return (Date.now() - fs.statSync(file).mtimeMs) / 1000;
	} catch {
		/* Fails open: an unreadable transcript reads as the parent's (#1837). */
		return null;
	}
}

/**
 * @param {{transcript_path?: unknown}} payload
 */
function hasFresherSubagentTranscript(payload) {
	const main = payload.transcript_path;
	if (typeof main !== "string" || !main.endsWith(".jsonl")) return false;
	const mainAge = ageS(main);
	if (mainAge === null || mainAge <= STALE_PARENT_S) return false;
	const dir = path.join(main.slice(0, -".jsonl".length), "subagents");
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch {
		/* Fails open: no subagents directory reads as the parent's (#1837). */
		return false;
	}
	return names.some((n) => {
		if (!/^agent-.*\.jsonl$/.test(n)) return false;
		const age = ageS(path.join(dir, n));
		return age !== null && age < FRESH_SUBAGENT_S && age < mainAge;
	});
}

/**
 * @param {unknown} payload
 * @returns {boolean}
 */
function isSubagentPayload(payload) {
	const p = /** @type {{agent_id?: unknown, hook_event_name?: unknown,
	 *   source?: unknown, transcript_path?: unknown} | null} */ (payload);
	const id = p?.agent_id;
	if (id !== undefined && id !== null && id !== false && id !== "") return true;
	return (
		p?.hook_event_name === "SessionStart" &&
		p.source === "compact" &&
		hasFresherSubagentTranscript(p)
	);
}

module.exports = { isSubagentPayload };
