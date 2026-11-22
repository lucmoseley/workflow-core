const { expandPastePaths } = require("./script-path.js");

const OWN_TERMINAL = "cd {host-root} && node {script:write-secret.js}";

/**
 * @param {string} name
 * @param {string} root
 * @param {boolean} fromTerminal
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
