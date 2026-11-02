/*
 * loop-prompts.js — the prompts the refill loop types into, or resumes, a
 * session it launched. Each opens with LOOP_PROMPT_PREFIX, so `isLoopPrompt`
 * tells lib/founder-typing.js, lib/tool-calls-since.js, retro-transcript.js
 * and pick-retro-sessions.js it is not the founder's typing (#3369, #3378,
 * #3381).
 */

const LOOP_PROMPT_PREFIX = "[refill loop] ";

/* #2359's wording. */
const API_PROMPT = `${LOOP_PROMPT_PREFIX}resume — your last turn ended on an API error. Before repeating your last tool call, check whether it already took effect.`;
/* #2659's wording. */
const IDLE_PROMPT = `${LOOP_PROMPT_PREFIX}resume — your host was restarted and your last turn never ran. Before repeating your last tool call, check whether it already took effect.`;
const LIMIT_LOSS =
	"Your in-flight subagents, background tasks and monitors are gone. Before repeating your last tool call, check whether it already took effect, then continue your task.";
/* A session a distro restart killed mid-work (#3880). */
const BOOT_PROMPT = `${LOOP_PROMPT_PREFIX}resume — a restart killed your session while it was running. ${LIMIT_LOSS}`;
/* A session its seat's limit stopped, resumed on that seat (#3735). */
const LIMIT_PROMPT = `${LOOP_PROMPT_PREFIX}resume — your seat's usage limit stopped you and has since reset, so you were resumed on the same seat. ${LIMIT_LOSS}`;
/* A session its seat's limit stopped, moved to another seat under its own id
 * (#3734). */
const MOVED_PROMPT = `${LOOP_PROMPT_PREFIX}resume — your seat's usage limit stopped you, so you were moved to another seat, in the same directory and under the same session id. ${LIMIT_LOSS}`;
/* A session parked on a repo hold that has since cleared (#3863). */
const HOLD_PROMPT = `${LOOP_PROMPT_PREFIX}resume — the repo hold you parked on has cleared. Check the founder act you were waiting on now reads done, then continue your task.`;
/* A parked session resumed by a normal-mode loop (#3621). */
const PARKED_PROMPT = `${LOOP_PROMPT_PREFIX}resume — the founder may be back. Where you parked on a question round or an act you handed him, make no tool call and post nothing to the issue. A round you do not re-print: point at it by number, ending \`needs input: Qn above — <the decision> — waits on you: #N\` under your \`waits on you:\` block. An act you repeat as it stands. Where you parked on neither and were waiting on him, post your question on the issue as a \`❓ **Qn**\` round carrying a \`**Hand-off:**\` and point at it as above; where you were waiting on nothing, continue your task. A tool call since this resume owes a fresh hand-off on the issue.`;
/* A session the loop stopped on a permission prompt, whose prompt went with the
 * stop (#3949). */
const PARKED_PERMISSION_PROMPT = `${LOOP_PROMPT_PREFIX}resume — the refill loop stopped you on a permission prompt and the founder may be back. Repeat the tool call that raised it, a subagent's by making it yourself, so the prompt comes back to him, then continue your task. Where you cannot repeat it, post a \`**Hand-off:**\` on the issue saying why, hand him the call as a literal \`!\` line or fenced text and what to send back, and end \`needs input: <the call> — waits on you: #N\` under your \`waits on you:\` block.`;
/* A session the loop stopped on an API error or a limit (#3949). */
const PARKED_NOTHING_PROMPT = `${LOOP_PROMPT_PREFIX}resume — the refill loop parked you on an API error or your seat's usage limit. ${LIMIT_LOSS}`;

const NOTHING_TO_REPEAT = new Set(["API_ERROR", "LIMIT"]);

/** @param {string|undefined} cause  the park marker's; none on a session's own park */
const hasNothingToRepeat = (cause) =>
	cause !== undefined && NOTHING_TO_REPEAT.has(cause);

/** @param {string|undefined} cause  the park marker's; none on a session's own park */
function parkedPromptOf(cause) {
	if (cause === "PERMISSION") return PARKED_PERMISSION_PROMPT;
	return hasNothingToRepeat(cause) ? PARKED_NOTHING_PROMPT : PARKED_PROMPT;
}

/** @param {string} text */
const isLoopPrompt = (text) => text.trimStart().startsWith(LOOP_PROMPT_PREFIX);

module.exports = {
	API_PROMPT,
	BOOT_PROMPT,
	IDLE_PROMPT,
	HOLD_PROMPT,
	LIMIT_PROMPT,
	MOVED_PROMPT,
	hasNothingToRepeat,
	isLoopPrompt,
	parkedPromptOf,
};
