/*
 * last30days.js — the dispatcher core that keeps the last30days skill inside
 * a subagent (#2792).
 *
 * Why: the skill costs ~87.4k tokens on invocation. Called inline they stay in
 * the working session's context, re-read on every later turn and hastening its
 * compaction. Called in a subagent, the fan-out stays in the subagent's own
 * context and only the findings come back.
 *
 * The signal is `agent_id`, which Claude Code sets on the hook payload ONLY
 * when the tool call originates inside a subagent: the kit hands it over as
 * `ctx.agent`. Absent or empty => main session => deny.
 *
 * LIMITS — this guards the Skill tool, and nothing else. It does not stop the
 * underlying engine being run directly through Bash, and it cannot: that path
 * is an ordinary command line with no distinguishing shape. Treat this as a
 * guard against the accidental inline call, which is the actual failure mode,
 * not as a hard capability boundary.
 */

const REASON = `last30days must run in a subagent, not the main session: one invocation pours ~87k tokens into this session's context, where every later turn re-reads them. Re-issue it via the Agent tool (subagent_type: general-purpose) with the research question in the prompt, and instruct that agent to invoke the last30days skill and report back only its findings. The same call will be allowed there.

Give that prompt an artefact line of its own:

    Artefact: .claude/tmp/last30days-<slug>.md

and tell the agent to append findings there as they land. From a throwaway worktree hand the absolute path instead, a relative one resolving inside that worktree.`;

/**
 * Plugin skills arrive namespaced ("last30days:last30days"); match either
 * form without matching some unrelated skill that merely mentions it.
 * @param {string} skill
 */
const ours = (skill) =>
	skill === "last30days" ||
	skill.startsWith("last30days:") ||
	skill.endsWith(":last30days");

/**
 * @param {string} skill
 * @param {import("./guard-dispatch.js").CoreContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(skill, ctx) {
	if (!ours(skill) || ctx.agent) return null;
	return { deny: REASON };
}

module.exports = { field: "skill", noun: "skill call", decide };
