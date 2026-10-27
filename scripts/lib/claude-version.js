/*
 * claude-version.js — the installed Claude Code's version, as
 * `<bin> --version` prints it.
 */

const { spawnSync } = require("node:child_process");

/* `claude --version` answers in ~20 ms (#2037); the ceiling is a guess (#901). */
const VERSION_TIMEOUT_MS = 10_000;

/**
 * The x.y.z `bin --version` prints, or null where it prints none.
 * @param {string} bin
 * @returns {string | null}
 */
function readClaudeVersion(bin) {
	const r = spawnSync(bin, ["--version"], {
		encoding: "utf8",
		timeout: VERSION_TIMEOUT_MS,
	});
	return /^\d+\.\d+\.\d+/m.exec(r.stdout ?? "")?.[0] ?? null;
}

module.exports = { readClaudeVersion };
