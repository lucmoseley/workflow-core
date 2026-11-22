const path = require("node:path");
const { claudeBin } = require("./claude-bin.js");
const { isPrefixedPrompt } = require("./loop-prompts.js");

// guess, #5529
const ATTACH_TIMEOUT_MS = 30 * 1000;

/**
 * @param {string} jobId
 * @param {string} prompt
 * @returns {[string, string[], {timeout: number}]}
 */
function buildTypedAttach(jobId, prompt) {
	if (!isPrefixedPrompt(prompt))
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
