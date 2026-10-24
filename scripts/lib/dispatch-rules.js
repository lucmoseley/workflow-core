/*
 * dispatch-rules.js — which of the dispatch rules one `Agent` call trips, for
 * `scripts/guard-dispatch-rewrite.sh` to print at that call (workflow-core#2013).
 *
 * Each check returns the line naming what THIS call did, or null. A subagent
 * dispatching a grandchild is judged in the hook, on the payload's `agent_id`.
 */

const { agentTypeOf } = require("./dispatch-artefact.js");
const { docPath } = require("./script-path.js");

/** The code reviewer, bare or namespaced as an adopter sees it. */
const REVIEWER = /^(?:[\w-]+:)?code-reviewer$/;

const GUIDE = `${docPath("effort-guide.md")} §Which model each subagent dispatch runs on`;

/**
 * Where a call's named model departs from the effort guide's dispatch routing
 * — `sonnet`, with `opus` for its two carve-outs — or null. Under burn mode
 * `opus` goes unjudged, and so does the reviewer's `sonnet`, which the remap
 * turns into the `opus` the guide asks for. Legal research, the
 * second carve-out, is invisible from the call, so an `opus` dispatch outside
 * the code reviewer is always named. A call-level `effort` is not judged.
 *
 * @param {Record<string, unknown>} call the tool_input object, before any rewrite
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
		return model === "opus" || (model === "sonnet" && burn)
			? null
			: `This dispatch names \`${model}\` for the code reviewer, a departure from ${GUIDE}.`;
	if (model === "sonnet" || (model === "opus" && burn)) return null;
	return `This dispatch names \`${model}\`, a departure from ${GUIDE} unless it is one of that section's carve-outs.`;
}

/*
 * "search the repo", and its spellings: a search verb, an optional
 * preposition, then the repo by one of its names. Anchored on the verb, so a
 * prompt that merely mentions the repo is not a search of it.
 */
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
