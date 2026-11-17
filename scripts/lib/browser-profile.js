/*
 * browser-profile.js — the dispatcher core that runs
 * scripts/browser-profile-guard.sh on a Bash command naming one of its
 * trigger words (#5384, #5389). The script's own first test is TRIGGER's
 * twin, so its machine copy, run on every Bash call, reads neither store on a
 * miss; a test holds the two equal.
 */

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

module.exports = { field: "command", noun: "command", decide, TRIGGER };
