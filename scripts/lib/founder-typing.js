/*
 * founder-typing.js — whether a UserPromptSubmit payload is a prompt the
 * founder typed (#3369, spec #1995).
 *
 * WHAT IS NOT HIS TYPING:
 *   - a dispatcher's or the refill loop's launch prompt: the prompt equal to
 *     the `intent` its job's state.json records, in a job not his own
 *     (lib/background-start.js). The prompt he launches a job with from the
 *     agents view is his typing: he is at the laptop on that seat, and a new
 *     session has no `.parked-` marker for it to clear (#3783).
 *   - a prompt the harness writes: a subagent's hand-back or another
 *     session's message (`<agent-message`, as probed), a task notification, a
 *     mod's delivery. The payload carries no origin field, and at this hook
 *     the transcript does not yet hold the prompt's record, so the text is
 *     all there is to read.
 *   - the refill loop's own resume prompts (lib/loop-prompts.js).
 *   - a print-mode run (`claude -p`, `CLAUDE_CODE_ENTRYPOINT` `sdk-cli`): a
 *     script's prompt. It inherits its parent's `CLAUDE_JOB_DIR`, so the
 *     intent test alone would count it.
 *   - a subagent's payload (lib/subagent-payload.js).
 *
 * The transcript's own frames — `<bash-stdout>`, `<local-command-`, Stop
 * hook feedback — never reach this hook: a `!` command, a local slash
 * command and a Stop block fire no UserPromptSubmit (probed on 2.1.312,
 * #3378).
 *
 * BLIND SPOTS: a scheduled task's or `/loop` iteration's prompt is its own
 * text, and counts. A `claude --bg` he types himself reads as a dispatcher's.
 */

const { isHisOwnJob } = require("./background-start.js");
const { readJobRecordIn } = require("./job-paths.js");
const { isLoopPrompt } = require("./loop-prompts.js");
const { isSubagentPayload } = require("./subagent-payload.js");

const HARNESS_PROMPT =
	/^\s*(?:<agent-message\s|<task-notification>|Delivered by the wfc-delivery mod)/;

/** @param {string} prompt */
function isDispatchedLaunchPrompt(prompt) {
	const jobDir = process.env.CLAUDE_JOB_DIR;
	if (!jobDir) return false;
	/* No readable job record marks nothing a launch (#2004). */
	const intent = readJobRecordIn(jobDir)?.intent;
	return (
		typeof intent === "string" &&
		intent.trim() === prompt.trim() &&
		!isHisOwnJob(process.env)
	);
}

/**
 * Whether a prompt's text alone marks it the harness's or the loop's.
 * @param {string} prompt
 */
const isMachineWrittenPrompt = (prompt) =>
	HARNESS_PROMPT.test(prompt) || isLoopPrompt(prompt);

/** @param {unknown} payload  the hook's parsed stdin */
function isFounderTyping(payload) {
	if (process.env.CLAUDE_CODE_ENTRYPOINT === "sdk-cli") return false;
	if (isSubagentPayload(payload)) return false;
	const raw = /** @type {{prompt?: unknown}|null} */ (payload)?.prompt;
	const prompt = typeof raw === "string" ? raw : "";
	return !(isMachineWrittenPrompt(prompt) || isDispatchedLaunchPrompt(prompt));
}

module.exports = { isFounderTyping, isMachineWrittenPrompt };
