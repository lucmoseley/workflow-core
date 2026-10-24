/*
 * empty-secret.js — why write-secret.js refuses an empty value, which turns
 * on where the value came from (#2554).
 */

const { expandPastePaths } = require("./script-path.js");

/* The own-terminal line, spelt as the SECRET paragraph of
 * docs/agents/rules/founder-handover.txt spells it. A copy rather than a read
 * through rule-text.js: the founder runs write-secret.js in his own terminal,
 * where an unreadable rule store must not cost the refusal. */
const OWN_TERMINAL = "cd {host-root} && node {script:write-secret.js}";

/**
 * @param {string} name
 * @param {string} root
 * @param {boolean} fromTerminal whether the value was typed at the hidden
 *   prompt rather than read from a stdin that is no terminal
 * @returns {string}
 */
function emptyWhy(name, root, fromTerminal) {
	if (fromTerminal)
		return `the value for ${name} is empty. Re-run and type or paste it before Enter.`;
	return (
		`the value for ${name} is empty: stdin is not a terminal, as under Claude Code's \`!\` prefix, so no hidden prompt could ask for it. ` +
		`Run this in your own terminal instead:\n${expandPastePaths(`${OWN_TERMINAL} ${name}`, root)}`
	);
}

module.exports = { emptyWhy };
