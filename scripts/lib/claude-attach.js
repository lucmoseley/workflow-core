/*
 * claude-attach.js — the typed resume's command: `prompt` typed into job
 * `jobId`'s live session through pty_type.py driving `claude attach`, which
 * needs a terminal (#2354 F6). refill-loop.js runs it, and
 * record-claude-responses.js records its exit for
 * lib/claude-attach.contract.test.ts (#3014).
 *
 * A typed line reaches the session's UserPromptSubmit hooks as the founder's
 * own would, so this types only a prompt lib/loop-prompts.js prefixes as the
 * loop's or a script's (#4844).
 */

const path = require("node:path");
const { claudeBin } = require("./claude-bin.js");
const { isLoopPrompt, isScriptPrompt } = require("./loop-prompts.js");

/* Untraced: a hang guard on the typed resume, past pty_type.py's longest run
 * (its DRAW_MAX_S draw wait then AFTER_ENTER_S, both untraced) plus a guessed
 * margin for `claude attach`'s start-up. */
const ATTACH_TIMEOUT_MS = 30 * 1000;

/**
 * The program, arguments and spawn options that type `prompt` into job
 * `jobId`; the caller adds its cwd and env to the options.
 * @param {string} jobId
 * @param {string} prompt
 * @returns {[string, string[], {timeout: number}]}
 * @throws where `prompt` opens with neither prefix
 */
function buildTypedAttach(jobId, prompt) {
	if (!isLoopPrompt(prompt) && !isScriptPrompt(prompt))
		throw new Error(
			`a prompt typed into ${jobId} must open with the loop's or a script's prefix (lib/loop-prompts.js), or it counts as the founder's typing: ${prompt}`,
		);
	return [
		"python3",
		[
			path.join(__dirname, "..", "pty_type.py"),
			prompt,
			"--",
			claudeBin(),
			"attach",
			jobId,
		],
		{ timeout: ATTACH_TIMEOUT_MS },
	];
}

module.exports = { ATTACH_TIMEOUT_MS, buildTypedAttach };
