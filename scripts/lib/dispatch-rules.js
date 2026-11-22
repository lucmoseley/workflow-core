const { agentTypeOf } = require("./dispatch-artefact.js");
const { docPath } = require("./script-path.js");

const REVIEWER = /^(?:[\w-]+:)?code-reviewer$/;

const GUIDE = `${docPath("effort-guide.md")} §Which model each subagent dispatch runs on`;

/**
 * @param {Record<string, unknown>} call
 * @param {boolean} burn
 * @returns {string|null}
 */
function tierDeparture(call, burn) {
	const model = typeof call.model === "string" ? call.model.trim() : "";
	if (!model) return null;
	const type = agentTypeOf(call);
	if (type === "fork")
		return `This dispatch names \`${model}\` on a fork, which ignores a \`model\` override and inherits this session's — see ${GUIDE}.`;
	if (REVIEWER.test(type))
		return model === "opus"
			? null
			: `This dispatch names \`${model}\` for the code reviewer, a departure from ${GUIDE}.`;
	if (model === "haiku" || (model === "opus" && burn)) return null;
	return `This dispatch names \`${model}\`, a departure from ${GUIDE} unless it is one of that section's carve-outs.`;
}

const SEARCH =
	/\b(?:search|grep|sweep|scan)(?:es|ed|ing)?\s+(?:(?:through|across|over|in)\s+)?(?:(?:the|this|whole|entire)\s+)*(?:repo|repository|codebase)\b/i;

const TRACKER =
	/\btracker\b|\bgh\s+(?:issue|search|api)\b|\bclosed\s+issues?\b|\bissue\s+(?:list|search)\b/i;

/**
 * @param {Record<string, unknown>} call
 * @returns {string|null}
 */
function untrackedSearch(call) {
	const prompt = call.prompt;
	if (typeof prompt !== "string") return null;
	if (!SEARCH.test(prompt) || TRACKER.test(prompt)) return null;
	return "This prompt asks for a search of the repo and names no tracker.";
}

module.exports = { tierDeparture, untrackedSearch };
