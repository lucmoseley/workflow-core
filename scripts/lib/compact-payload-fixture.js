/*
 * compact-payload-fixture.js — test fixture: the `PreCompact` and
 * `SessionStart:compact` payloads harness 2.1.301 sends, read off its hook-input
 * builder (workflow-core#1785), and the transcripts on disk beside them (workflow-core#1837). A
 * subagent's autocompaction and its parent's send the same shape: the
 * parent's `session_id` and `transcript_path`, and no `agent_id`.
 * `agent_type` and `session_title` are left out, being absent outside an
 * `--agent` session or a titled one.
 */

const fs = require("node:fs");
const path = require("node:path");

/**
 * @param {{sessionId: string, transcriptPath: string, cwd: string,
 *   agentId?: string}} at  `agentId` adds the field the harness's schema
 *   documents for a subagent's hooks
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

/* Transcript ages a subagent's compaction leaves, well clear of both of
 * lib/subagent-payload.js's thresholds. */
const SUBAGENT_JUST_COMPACTED = { parentAgeS: 300, subagentAgesS: [20] };

/**
 * Lays out a session's transcripts under `dir` as the harness does — the
 * parent's `<sid>.jsonl`, each subagent's `<sid>/subagents/agent-*.jsonl` —
 * each last written the given seconds ago. A parent transcript already there
 * keeps its content and is only aged.
 * @param {string} dir
 * @param {{sessionId: string, parentAgeS: number, subagentAgesS?: number[]}} at
 * @returns {string}
 */
function compactTranscripts(
	dir,
	{ sessionId, parentAgeS, subagentAgesS = [] },
) {
	/** @param {string} file @param {number} ageS */
	const write = (file, ageS) => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		if (!fs.existsSync(file)) fs.writeFileSync(file, "{}\n");
		const t = (Date.now() - ageS * 1000) / 1000;
		fs.utimesSync(file, t, t);
	};
	const main = path.join(dir, `${sessionId}.jsonl`);
	write(main, parentAgeS);
	subagentAgesS.forEach((ageS, i) => {
		write(path.join(dir, sessionId, "subagents", `agent-a${i}.jsonl`), ageS);
	});
	return main;
}

module.exports = {
	compactPayloads,
	compactTranscripts,
	SUBAGENT_JUST_COMPACTED,
};
