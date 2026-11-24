const { isHisJobRecord } = require("./background-start.js");
const { readJobDir, readJobRecordIn } = require("./job-paths.js");
const { isPrefixedPrompt } = require("./loop-prompts.js");
const { isSubagentPayload } = require("./subagent-payload.js");

const HARNESS_PROMPT =
	/^\s*(?:<agent-message\s|<task-notification>|Delivered by the wfc-delivery mod)/;

/** @param {string} prompt */
function isDispatchedLaunchPrompt(prompt) {
	const jobDir = readJobDir(process.env);
	if (!jobDir) return false;
	const record = readJobRecordIn(jobDir);
	const intent = record?.intent;
	return (
		typeof intent === "string" &&
		intent.trim() === prompt.trim() &&
		!isHisJobRecord(record)
	);
}

/**
 * @param {string} prompt
 */
const isMachineWrittenPrompt = (prompt) =>
	HARNESS_PROMPT.test(prompt) || isPrefixedPrompt(prompt);

/** @param {unknown} payload */
function isFounderTyping(payload) {
	if (process.env.CLAUDE_CODE_ENTRYPOINT === "sdk-cli") return false;
	if (isSubagentPayload(payload)) return false;
	const raw = /** @type {{prompt?: unknown}|null} */ (payload)?.prompt;
	const prompt = typeof raw === "string" ? raw : "";
	return !(isMachineWrittenPrompt(prompt) || isDispatchedLaunchPrompt(prompt));
}

module.exports = { isFounderTyping, isMachineWrittenPrompt };
