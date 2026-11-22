const fs = require("node:fs");

const OWN_AGENT_REL = ".claude/agents/code-reviewer.md";

/**
 * @param {string} hostRoot
 * @returns {"code-reviewer" | "workflow-core:code-reviewer"}
 */
function reviewAgentType(hostRoot) {
	const own = fs
		.statSync(`${hostRoot}/${OWN_AGENT_REL}`, {
			throwIfNoEntry: false,
		})
		?.isFile();
	return own ? "code-reviewer" : "workflow-core:code-reviewer";
}

module.exports = { OWN_AGENT_REL, reviewAgentType };
