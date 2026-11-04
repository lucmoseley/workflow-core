/*
 * claude-bin.js — the `claude` binary to run: WFC_CLAUDE_BIN, else `claude`.
 * Overridable so a suite can stand a fake in without a daemon. Read per call,
 * not frozen at load: the sandbox re-points it between tests.
 */

const claudeBin = () => process.env.WFC_CLAUDE_BIN || "claude";

module.exports = { claudeBin };
