/*
 * claude-bin.js — the `claude` binary to run: WFC_CLAUDE_BIN, else `claude`.
 * Overridable so a suite can stand a fake in without a daemon. Read per call,
 * not frozen at load: the sandbox re-points it between tests. A site launching
 * under an environment of its own passes it, so the binary is the child's
 * (workflow-core#3991). A leaf, so lib/headless-sessions.js and lib/agent-liveness.js share
 * it without a cycle.
 */

/** @param {NodeJS.ProcessEnv} [env] */
const claudeBin = (env = process.env) => env.WFC_CLAUDE_BIN || "claude";

module.exports = { claudeBin };
