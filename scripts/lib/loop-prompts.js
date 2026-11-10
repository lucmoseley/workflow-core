/*
 * loop-prompts.js — the prompts a script types into, or resumes, a session
 * with, each opening with a prefix that marks it no typing of the founder's:
 * the refill loop's with LOOP_PROMPT_PREFIX (#3369, #3378, #3381), any other
 * script's with SCRIPT_PROMPT_PREFIX, through `scriptPrompt` (#4844).
 * `isPrefixedPrompt` reads either, for lib/founder-typing.js,
 * lib/tool-calls-since.js, lib/claude-attach.js, pick-retro-sessions.js and
 * rescue-sessions.js; retro-transcript.js labels each by its own.
 */

const { scriptPath } = require("./script-path.js");

const LOOP_PROMPT_PREFIX = "[refill loop] ";
const SCRIPT_PROMPT_PREFIX = "[script] ";

/* #2359's wording. */
const API_PROMPT = `${LOOP_PROMPT_PREFIX}resume — your last turn ended on an API error. Before repeating your last tool call, check whether it already took effect.`;
/* #2659's wording. */
const IDLE_PROMPT = `${LOOP_PROMPT_PREFIX}resume — your host was restarted and your last turn never ran. Before repeating your last tool call, check whether it already took effect.`;
const LOST =
	"Your in-flight subagents, background tasks and monitors are gone.";
const LIMIT_LOSS = `${LOST} Before repeating your last tool call, check whether it already took effect, then continue your task.`;
/* A session a restart killed may come back as a copy beside its original, and
 * either may be revived (#4098): the claim decides which carries on. */
const TWIN_CHECK = `A copy or the original of this session may be live beside you: first re-run \`node ${scriptPath("claim-issue.js")} <n>\` on each issue you hold, and where it refuses on a live holder, that session carries the work, so make no other tool call and end your turn saying so.`;
/* A session a distro restart killed mid-work (#3880). */
const BOOT_PROMPT = `${LOOP_PROMPT_PREFIX}resume — a restart killed your session while it was running. ${TWIN_CHECK} ${LIMIT_LOSS}`;
/* A session its seat's limit stopped, resumed on that seat (#3735). */
const LIMIT_PROMPT = `${LOOP_PROMPT_PREFIX}resume — your seat's usage limit stopped you and has since reset, so you were resumed on the same seat. ${LIMIT_LOSS}`;
/* A session its seat's limit stopped, moved to another seat under its own id
 * (#3734). */
const MOVED_PROMPT = `${LOOP_PROMPT_PREFIX}resume — your seat's usage limit stopped you, so you were moved to another seat, in the same directory and under the same session id. ${LIMIT_LOSS}`;
/* A session parked on a repo hold that has since cleared (#3863). */
const HOLD_PROMPT = `${LOOP_PROMPT_PREFIX}resume — the repo hold you parked on has cleared. Check the founder act you were waiting on now reads done, then continue your task.`;
/* What a session that may be waiting on the founder does on its resume. */
const PARK_STEPS =
	"Where you parked on a question round or an act you handed him, make no tool call and post nothing to the issue. A round you do not re-print: point at it by number, ending `needs input: Qn above — <the decision> — waits on you: #N` under your `waits on you:` block. An act you repeat as it stands. Where you parked on neither and were waiting on him, post your question on the issue as a `❓ **Qn**` round carrying a `**Hand-off:**` and point at it as above; where you were waiting on nothing, continue your task. A tool call since this resume owes a fresh hand-off on the issue.";
/* A parked session resumed by a normal-mode loop (#3621). */
const PARKED_PROMPT = `${LOOP_PROMPT_PREFIX}resume — the founder may be back. ${PARK_STEPS}`;
/* A session a restart killed on a block the loop could not read (#3980). */
const BOOT_UNREAD_PROMPT = `${LOOP_PROMPT_PREFIX}resume — a restart killed your session while it was blocked, and the loop could not read on what, so you may be waiting on the founder. ${LOST} ${PARK_STEPS} Where you continue, first re-run \`node ${scriptPath("claim-issue.js")} <n>\` on each issue you hold, since a copy or the original of this session may be live beside you: where it refuses on a live holder, that session carries the work, so make no other tool call and end your turn saying so. Then check whether your last tool call already took effect.`;
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

/** @param {string} text  what a script, not the loop, types or resumes with */
const scriptPrompt = (text) => `${SCRIPT_PROMPT_PREFIX}${text}`;

/** @param {string} text */
const isScriptPrompt = (text) =>
	text.trimStart().startsWith(SCRIPT_PROMPT_PREFIX);

/**
 * Whether `text` opens with the loop's prefix or a script's.
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
	hasNothingToRepeat,
	isLoopPrompt,
	isPrefixedPrompt,
	isScriptPrompt,
	parkedPromptOf,
	scriptPrompt,
};
