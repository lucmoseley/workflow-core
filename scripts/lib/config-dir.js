/*
 * config-dir.js — the Claude Code config dir a script's records live under.
 *
 * From the environment, never a literal ~/.claude: a test re-points
 * CLAUDE_CONFIG_DIR at a sandbox, where a literal would write into the
 * founder's live registry and wedge real sessions, and each of this machine's
 * subscriptions runs under its own dir.
 *
 * `??`, not `||`: an empty CLAUDE_CONFIG_DIR is set, as Claude Code's own
 * resolver reads it (2.1.304: `CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")`),
 * so its records resolve against the cwd and are read where the harness wrote
 * them, never in the live ~/.claude (#2095). lib/guard-root.sh's gr_config_dir
 * is the shell twin, and resolve-core.js spells the rule itself, as it ships to
 * adopters alone and requires node builtins only.
 */

const os = require("node:os");
const path = require("node:path");

/**
 * The config dir a CLAUDE_CONFIG_DIR value names: this process's own, or one
 * read from another process's environ.
 * @param {string|null|undefined} value
 * @returns {string}
 */
function configDirFrom(value) {
	return value ?? path.join(os.homedir(), ".claude");
}

/**
 * A config dir in the form `~/.claude/refill-seats` entries take, so two
 * spellings of one dir compare equal.
 * @param {string} p @param {string} home
 */
function seatDir(p, home) {
	return path.resolve(p.startsWith("~/") ? path.join(home, p.slice(2)) : p);
}

function configDir() {
	return configDirFrom(process.env.CLAUDE_CONFIG_DIR);
}

module.exports = { configDir, configDirFrom, seatDir };
