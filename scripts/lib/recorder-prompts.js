/*
 * recorder-prompts.js — the prompts record-claude-responses.js launches,
 * resumes and types its probe jobs with, apart from the script so
 * mark-presence.test.ts feeds the presence hook the line the script types
 * (#4844).
 */

const { scriptPrompt } = require("./loop-prompts.js");

const PROMPT = "Reply with the single word ok. Use no tools.";
/* PROMPT as typed into, or resumed in, a job whose launch intent it is not:
 * there only the prefix tells the presence hook it is no typing of the
 * founder's. */
const SCRIPTED_PROMPT = scriptPrompt(PROMPT);
/* The launch prompt of the job the typed attach types into. */
const ASK =
	"Ask me one question, whether I prefer red or blue, with the AskUserQuestion tool. Use no other tool.";
/* Under `--permission-mode manual` a Bash write prompts. */
const PERMISSION_ASK =
	"Run exactly this Bash command and nothing else: touch /tmp/wfc-permission-probe. Use no other tool.";

module.exports = { ASK, PERMISSION_ASK, PROMPT, SCRIPTED_PROMPT };
