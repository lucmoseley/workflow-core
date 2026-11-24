/**
 * @param {{sessionId: string, transcriptPath: string, cwd: string,
 *   agentId?: string}} at
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
