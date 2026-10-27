/*
 * ugrep-pattern-host.js — the production port guard-ugrep-pattern.js wires
 * into its core, lib/ugrep-pattern.js (workflow-core#2801): the core-path rewrite on the
 * note, so an install outside this checkout is pointed at the
 * plugin's own docs/agents/tool-output.md.
 */

const { resolveScriptPaths } = require("./script-path.js");

/** @returns {{ corePaths: (text: string) => string }} */
const buildHostPorts = () => ({ corePaths: resolveScriptPaths });

module.exports = { buildHostPorts };
