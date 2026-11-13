/*
 * bg-launch-id.js — the job id in what `claude --bg` printed (#4343), for the
 * dispatcher's ledger row (#5145). lib/bg-launch-id.sh is the bash twin
 * start-session.sh sources; scripts/lib/bg-launch.contract.test.ts holds both
 * to the recorded launch.
 */

/* A terminal colour or cursor escape, which surrounds the id. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape is the subject
const ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/g;

/**
 * @param {string} stdout a launch's stdout
 * @returns {string} the first run of 8 hex characters in its first line that
 *   holds one, `backgrounded · <id> · <name> …`; "" where there is none
 */
function bgLaunchId(stdout) {
	for (const line of stdout.replace(ESCAPE, "").split("\n")) {
		const m = line.match(/[0-9a-f]{8}/);
		if (m) return m[0];
	}
	return "";
}

module.exports = { bgLaunchId };
