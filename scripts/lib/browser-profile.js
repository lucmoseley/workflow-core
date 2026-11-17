/*
 * browser-profile.js — the dispatcher core that runs
 * scripts/browser-profile-guard.sh on a Bash command naming one of its
 * trigger words (#5384, #5389). The script's own first test names the same
 * words, so its machine copy, run on every Bash call, reads neither store on a
 * miss. A test holds every word of that gate admitted here; a word added here
 * alone costs a script start, never a missed refusal.
 *
 * FAILS CLOSED (guard-cores.json): where the script crashes, times out or
 * answers no hook JSON, the call is refused, since a launch let through
 * unjudged may open the founder's tab in another account's profile (#5383
 * user story 5).
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

module.exports = { field: "command", noun: "command", decide };
