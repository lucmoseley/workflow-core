/*
 * founder-typing.js — whether a UserPromptSubmit payload is a prompt the
 * founder typed (#3369, spec #1995).
 *
 * WHAT IS NOT HIS TYPING:
 *   - a background job's launch prompt: the prompt equal to the `intent` its
 *     job's state.json records. A launch from the agents view is skipped
 *     with the dispatcher's, since nothing on the job tells the two apart;
 *     his later prompts in that job count.
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
 * text, and counts.
 */

const fs = require("node:fs");
const { jobStateIn } = require("./job-paths.js");
const { isLoopPrompt } = require("./loop-prompts.js");
const { isSubagentPayload } = require("./subagent-payload.js");

const HARNESS_PROMPT =
	/^\s*(?:<agent-message\s|<task-notification>|Delivered by the wfc-delivery mod)/;

/** @param {string} prompt */
function isLaunchPrompt(prompt) {
	const jobDir = process.env.CLAUDE_JOB_DIR;
	if (!jobDir) return false;
	try {
		const { intent } = JSON.parse(fs.readFileSync(jobStateIn(jobDir), "utf8"));
		return typeof intent === "string" && intent.trim() === prompt.trim();
	} catch {
		/* No readable job record marks nothing a launch (#2004). */
		return false;
	}
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
	return !(isMachineWrittenPrompt(prompt) || isLaunchPrompt(prompt));
}

module.exports = { isFounderTyping, isMachineWrittenPrompt };
