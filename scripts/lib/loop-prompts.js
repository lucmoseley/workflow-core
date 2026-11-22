const { scriptPath } = require("./script-path.js");

const LOOP_PROMPT_PREFIX = "[refill loop] ";
const SCRIPT_PROMPT_PREFIX = "[script] ";

// #2359
const API_PROMPT = `${LOOP_PROMPT_PREFIX}resume — your last turn ended on an API error. Before repeating your last tool call, check whether it already took effect.`;
// #2659
const IDLE_PROMPT = `${LOOP_PROMPT_PREFIX}resume — your host was restarted and your last turn never ran. Before repeating your last tool call, check whether it already took effect.`;
const RECLAIM = `re-run \`node ${scriptPath("claim-issue.js")} <n>\` on each issue you hold: where it refuses on a live holder, that session carries the work, so make no other tool call and end your turn saying so.`;
const SYNTHETIC_PROMPT = `${LOOP_PROMPT_PREFIX}resume — the harness ended your last turn with "No response requested.": you did not end it, and your task is not done. First ${RECLAIM} Before repeating your last tool call, check whether it already took effect, then continue your task.`;
const LOST =
	"Your in-flight subagents, background tasks and monitors are gone.";
const LIMIT_LOSS = `${LOST} Before repeating your last tool call, check whether it already took effect, then continue your task.`;
const TWIN_CHECK = `A copy or the original of this session may be live beside you: first ${RECLAIM}`;
const BOOT_PROMPT = `${LOOP_PROMPT_PREFIX}resume — a restart killed your session while it was running. ${TWIN_CHECK} ${LIMIT_LOSS}`;
const LIMIT_PROMPT = `${LOOP_PROMPT_PREFIX}resume — your seat's usage limit stopped you and has since reset, so you were resumed on the same seat. ${LIMIT_LOSS}`;
const MOVED_PROMPT = `${LOOP_PROMPT_PREFIX}resume — your seat's usage limit stopped you, so you were moved to another seat, in the same directory and under the same session id. ${LIMIT_LOSS}`;
const HOLD_PROMPT = `${LOOP_PROMPT_PREFIX}resume — the repo hold you parked on has cleared. Check the founder act you were waiting on now reads done, then continue your task.`;
const PARK_STEPS =
	"Where you parked on a question round or an act you handed him, make no tool call and post nothing to the issue. A round you do not re-print: point at it by number, ending `needs input: Qn above — <the decision> — waits on you: #N` under your `waits on you:` block. An act you repeat as it stands. Where you parked on neither and were waiting on him, post your question on the issue as a `❓ **Qn**` round carrying a `**Hand-off:**` and point at it as above; where you were waiting on nothing, continue your task. A tool call since this resume owes a fresh hand-off on the issue.";
const PARKED_PROMPT = `${LOOP_PROMPT_PREFIX}resume — the founder may be back. ${PARK_STEPS}`;
const BOOT_UNREAD_PROMPT = `${LOOP_PROMPT_PREFIX}resume — a restart killed your session while it was blocked, and the loop could not read on what, so you may be waiting on the founder. ${LOST} ${PARK_STEPS} A copy or the original of this session may be live beside you. Where you continue, first ${RECLAIM} Then check whether your last tool call already took effect.`;
const PARKED_PERMISSION_PROMPT = `${LOOP_PROMPT_PREFIX}resume — the refill loop stopped you on a permission prompt and the founder may be back. Repeat the tool call that raised it, a subagent's by making it yourself, so the prompt comes back to him, then continue your task. Where you cannot repeat it, post a \`**Hand-off:**\` on the issue saying why, hand him the call as a literal \`!\` line or fenced text and what to send back, and end \`needs input: <the call> — waits on you: #N\` under your \`waits on you:\` block.`;
const PARKED_NOTHING_PROMPTS = {
	API_ERROR: `${LOOP_PROMPT_PREFIX}resume — the refill loop parked you on an API error. ${LIMIT_LOSS}`,
	LIMIT: `${LOOP_PROMPT_PREFIX}resume — the refill loop parked you on your seat's usage limit. ${LIMIT_LOSS}`,
};

/**
 * @param {string|undefined} cause
 * @returns {cause is keyof typeof PARKED_NOTHING_PROMPTS}
 */
const hasNothingToRepeat = (cause) =>
	cause !== undefined && Object.hasOwn(PARKED_NOTHING_PROMPTS, cause);

/** @param {string|undefined} cause */
function parkedPromptOf(cause) {
	if (cause === "PERMISSION") return PARKED_PERMISSION_PROMPT;
	return hasNothingToRepeat(cause)
		? PARKED_NOTHING_PROMPTS[cause]
		: PARKED_PROMPT;
}

/** @param {string} text */
const isLoopPrompt = (text) => text.trimStart().startsWith(LOOP_PROMPT_PREFIX);

/** @param {string} text */
const scriptPrompt = (text) => `${SCRIPT_PROMPT_PREFIX}${text}`;

/** @param {string} text */
const isScriptPrompt = (text) =>
	text.trimStart().startsWith(SCRIPT_PROMPT_PREFIX);

/**
 * @param {string} text
 */
const isPrefixedPrompt = (text) => isLoopPrompt(text) || isScriptPrompt(text);

module.exports = {
	API_PROMPT,
	BOOT_PROMPT,
	BOOT_UNREAD_PROMPT,
	IDLE_PROMPT,
	HOLD_PROMPT,
	LIMIT_PROMPT,
	MOVED_PROMPT,
	SYNTHETIC_PROMPT,
	hasNothingToRepeat,
	isLoopPrompt,
	isPrefixedPrompt,
	isScriptPrompt,
	parkedPromptOf,
	scriptPrompt,
};
