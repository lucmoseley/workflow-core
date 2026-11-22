const { runOnTrigger } = require("./shell-guard.js");

const TRIGGER =
	/chrome\.exe|xdg-open|wslview|explorer\.exe|cmd\.exe|start-process|url\.dll|auth +login|npm +login/i;

/**
 * @param {string} command
 * @param {import("./shell-guard.js").ShellGuardContext} ctx
 */
function decide(command, ctx) {
	return runOnTrigger("browser-profile-guard.sh", TRIGGER, command, ctx);
}

module.exports = { field: "command", noun: "command", decide };
