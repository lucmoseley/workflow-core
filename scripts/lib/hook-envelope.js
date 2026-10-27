/*
 * hook-envelope.js — the dispatcher's merged output in its event's own
 * decision control (workflow-core#2787). A module of its own so each event's shape is
 * tested through its export rather than one exported for the test (base §G6).
 */

/**
 * PostToolUse has no permission: the tool has run, so a deny is its top-level
 * `decision: "block"`, which hands the reason to the session beside the result
 * (vendor hooks reference §PostToolUse decision control).
 * @param {string} event
 * @param {Record<string, unknown>} output the merged output, a rewrite's
 *   `updatedInput` included
 */
function envelope(event, output) {
	if (event !== "PostToolUse")
		return { hookSpecificOutput: { hookEventName: event, ...output } };
	const { permissionDecision, permissionDecisionReason, additionalContext } =
		output;
	return {
		...(permissionDecision === "deny" && {
			decision: "block",
			reason: permissionDecisionReason,
		}),
		...(typeof additionalContext === "string" &&
			additionalContext !== "" && {
				hookSpecificOutput: { hookEventName: event, additionalContext },
			}),
	};
}

module.exports = { envelope };
