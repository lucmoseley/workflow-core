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
/* A parked session resumed by a normal-mode loop (#3621). */
const PARKED_PROMPT = `${LOOP_PROMPT_PREFIX}resume — the founder may be back. Repeat your open question round here as it stands, without posting it to the issue again, and end your turn waiting on his answer.`;

/** @param {string} text */
const isLoopPrompt = (text) => text.trimStart().startsWith(LOOP_PROMPT_PREFIX);

module.exports = { API_PROMPT, IDLE_PROMPT, PARKED_PROMPT, isLoopPrompt };
