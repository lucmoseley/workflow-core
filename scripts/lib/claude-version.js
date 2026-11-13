/*
 * claude-version.js — the installed Claude Code's version, as
 * `<bin> --version` prints it.
 */

const { spawnRaw } = require("./child-spawn.js");

/* `claude --version` answers in ~20 ms (#2037); the ceiling is a guess (#901). */
const VERSION_TIMEOUT_MS = 10_000;

/**
 * The x.y.z `bin --version` prints, or why it printed none.
 * @param {string} bin
 * @param {typeof spawnRaw} [spawn] the call, where a test runs it in-process
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
 * The x.y.z `bin --version` prints, or null where it prints none.
 * @param {string} bin
 * @returns {string | null}
 */
function readClaudeVersion(bin) {
	const r = readClaudeVersionOrWhy(bin);
	return "version" in r ? r.version : null;
}

module.exports = { readClaudeVersion, readClaudeVersionOrWhy };
