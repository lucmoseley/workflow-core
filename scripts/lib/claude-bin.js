/*
 * claude-bin.js — the `claude` binary to run: WFC_CLAUDE_BIN, else `claude`.
 * Overridable so a suite can stand a fake in without a daemon. Read per call,
 * not frozen at load: the sandbox re-points it between tests. A leaf, so
 * lib/headless-sessions.js shares it with lib/agent-liveness.js, which
 * requires that module, without a cycle.
 */

const claudeBin = () => process.env.WFC_CLAUDE_BIN || "claude";

module.exports = { claudeBin };
