const path = require("node:path");

const CLAUDE_NAME = /^claude(\.exe)?$/;
const CLAUDE_VERSIONED = /(^|\/)claude\/versions\/[^/]+$/;

/** @param {string | null | undefined} argv0 */
function isClaudeArgv0(argv0) {
	if (!argv0) return false;
	return CLAUDE_NAME.test(path.basename(argv0)) || CLAUDE_VERSIONED.test(argv0);
}

module.exports = { isClaudeArgv0 };
