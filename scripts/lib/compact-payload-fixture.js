/*
 * compact-payload-fixture.js — test fixture: the `PreCompact` and
 * `SessionStart:compact` payloads harness 2.1.323 sends, read off its
 * hook-input builder (#1785, #1837). A subagent's autocompaction carries its
 * parent's `session_id` and `transcript_path`, and adds `agent_id`;
 * `PreCompact` adds its `agent_type` too. `SessionStart`'s `agent_type` and
 * `session_title` are left out, being absent outside an `--agent` session or
 * a titled one.
 */

/**
 * @param {{sessionId: string, transcriptPath: string, cwd: string,
 *   agentId?: string}} at  `agentId` makes it a subagent's compaction
 * @returns {{preCompact: Record<string, unknown>,
 *   sessionStart: Record<string, unknown>}}
 */
function compactPayloads({ sessionId, transcriptPath, cwd, agentId }) {
	const base = {
		session_id: sessionId,
		transcript_path: transcriptPath,
		cwd,
		...(agentId ? { agent_id: agentId } : {}),
	};
	return {
		preCompact: {
			...base,
			...(agentId ? { agent_type: "general-purpose" } : {}),
			hook_event_name: "PreCompact",
			trigger: "auto",
			custom_instructions: null,
		},
		sessionStart: {
			...base,
			hook_event_name: "SessionStart",
			source: "compact",
			model: "claude-haiku-5-5",
		},
	};
}

module.exports = { compactPayloads };
