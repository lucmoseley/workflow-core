/*
 * claude-attach.js — the typed resume's command: `prompt` typed into job
 * `jobId`'s live session through pty_type.py driving `claude attach`, which
 * needs a terminal (workflow-core#2354 F6). refill-loop.js runs it, and
 * record-claude-responses.js records its exit for
 * lib/claude-attach.contract.test.ts (workflow-core#3014).
 */

const path = require("node:path");
const { claudeBin } = require("./claude-bin.js");

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
 */
const buildTypedAttach = (jobId, prompt) => [
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

module.exports = { ATTACH_TIMEOUT_MS, buildTypedAttach };
