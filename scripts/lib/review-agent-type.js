/*
 * review-agent-type.js — the subagent type the two review axes are dispatched
 * on (#741).
 *
 * A PLUGIN AGENT IS NAMESPACED: an adopter, which has only the plugin's copy,
 * is offered `workflow-core:code-reviewer`, and a bare `code-reviewer` is
 * refused as not found. The core runs from its own `.claude/agents/`, where
 * the bare name is the only one. So the host's own definition, where present,
 * wins.
 *
 * lib/review-agent-type.sh is the bash twin, still sourced by
 * inject-tracker-docs.sh and concision-backstop.sh until #2802 deletes it;
 * keep the two in step.
 * review-agent-type.test.ts holds them to one answer, and
 * review-suffix.test.ts holds every route to it on both kinds of host.
 */

const fs = require("node:fs");

/**
 * @param {string} hostRoot symlinks dereferenced, as lib/host-root.js gives it
 * @returns {"code-reviewer" | "workflow-core:code-reviewer"}
 */
function reviewAgentType(hostRoot) {
	const own = fs
		.statSync(`${hostRoot}/.claude/agents/code-reviewer.md`, {
			throwIfNoEntry: false,
		})
		?.isFile();
	return own ? "code-reviewer" : "workflow-core:code-reviewer";
}

module.exports = { reviewAgentType };
