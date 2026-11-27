const path = require("node:path");
const { runCommand } = require("./run-command.js");

// guess, workflow-core#5044
const HOLD_MAX_MINUTES = 60;

/**
 * @param {string} holder
 * @param {"hold" | "release"} act
 * @returns {string | null}
 */
function setLaunchHold(holder, act) {
	const args =
		act === "hold"
			? ["--hold-launches", String(HOLD_MAX_MINUTES)]
			: ["--release-launches"];
	return runCommand(
		process.execPath,
		[path.join(__dirname, "..", "refill-loop.js"), "set", ...args],
		{ env: { ...process.env, CLAUDE_CODE_SESSION_ID: holder } },
	).error;
}

module.exports = { HOLD_MAX_MINUTES, setLaunchHold };
