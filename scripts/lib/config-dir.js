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
 * them, never in the live ~/.claude (workflow-core#2095). lib/guard-root.sh's gr_config_dir
 * is the shell twin.
 */

const os = require("node:os");
const path = require("node:path");

function configDir() {
	return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

module.exports = { configDir };
