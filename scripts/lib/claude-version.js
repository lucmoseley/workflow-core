const { spawnRaw } = require("./child-spawn.js");

/* `claude --version` answers in ~20 ms (#2037); the ceiling is a guess (#901). */
const VERSION_TIMEOUT_MS = 10_000;

/**
 * @param {string} bin
 * @param {typeof spawnRaw} [spawn]
 * @returns {{ version: string } | { why: string }}
 */
function readClaudeVersionOrWhy(bin, spawn = spawnRaw) {
	const r = spawn(bin, ["--version"], { timeout: VERSION_TIMEOUT_MS });
	const version = /^\d+\.\d+\.\d+/m.exec(r.stdout ?? "")?.[0];
	if (version) return { version };
	return {
		why: `exit ${r.status}${r.error ? `, ${r.error.message}` : ""}`,
	};
}

/**
 * @param {string} bin
 * @returns {string | null}
 */
function readClaudeVersion(bin) {
	const r = readClaudeVersionOrWhy(bin);
	return "version" in r ? r.version : null;
}

module.exports = { readClaudeVersion, readClaudeVersionOrWhy };
