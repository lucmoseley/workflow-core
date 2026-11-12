/*
 * subagent-payload.js — whether a hook payload came from a subagent. The shell
 * hooks ask it through lib/subagent-payload.sh.
 *
 * A payload carrying an `agent_id` is a subagent's; the parent's never do.
 * The field reads as jq's `// ""` does, so `null`, `false` and `""` read as
 * the parent's. Harness 2.1.323 sends it on a subagent's `PreCompact` and
 * `SessionStart:compact` too, whose `session_id` and `transcript_path` are
 * the parent's (#1785, #1837).
 */

/**
 * @param {unknown} payload
 * @returns {boolean}
 */
function isSubagentPayload(payload) {
	const id = /** @type {{agent_id?: unknown} | null} */ (payload)?.agent_id;
	return id !== undefined && id !== null && id !== false && id !== "";
}

module.exports = { isSubagentPayload };
