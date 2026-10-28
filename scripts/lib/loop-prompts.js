/*
 * loop-prompts.js — the prompts the refill loop types into, or resumes, a
 * session it launched. Each opens with LOOP_PROMPT_PREFIX, which
 * lib/founder-typing.js reads as not the founder's typing (#3369).
 */

const LOOP_PROMPT_PREFIX = "[refill loop] ";

/* #2359's wording. */
const API_PROMPT = `${LOOP_PROMPT_PREFIX}resume — your last turn ended on an API error. Before repeating your last tool call, check whether it already took effect.`;
/* #2659's wording. */
const IDLE_PROMPT = `${LOOP_PROMPT_PREFIX}resume — your host was restarted and your last turn never ran. Before repeating your last tool call, check whether it already took effect.`;

module.exports = { API_PROMPT, IDLE_PROMPT, LOOP_PROMPT_PREFIX };
