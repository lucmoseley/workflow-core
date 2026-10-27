#!/usr/bin/env node
/*
 * guard-npm-install.js — PreToolUse guard: the npm install boundary
 * (mantahostels#1803, ruled at mantahostels#1767). The core, with its three
 * checks, thresholds and LIMITS, is lib/npm-install.js; its production ports
 * are lib/npm-install-host.js.
 *
 * DENIES an install adding a package without `--ignore-scripts`, a new
 * package the registry does not vouch for (missing, under 180 days, under
 * 1,000 downloads a month, unvettable, or unchecked), and a bare `npx <name>`
 * naming no dependency.
 *
 * DENIES-THROUGH: lib/guard-entry.js — the registration carries
 * `"onFailure": "block"`, so a crash or timeout refuses.
 *
 * FAILURE POLICY. A core that throws refuses (lib/refuse-on-throw.js). A
 * registry that cannot be asked — `npm` or `curl` missing, a call timed out,
 * the 30 s budget spent — refuses, the missing program logged
 * (mantahostels#1767). An unreadable or unparsable package.json allows,
 * logged. A payload fault allows, logged, as the kit does.
 *
 * LIMITS
 *  - Wired with `if: Bash(*npm *)` and `if: Bash(*npx *)` (mantahostels#2811).
 *    They are best-effort (hooks.md:448): the core re-reads the command
 *    itself.
 *
 * IMPLICIT: it refuses a new dependency the three checks cannot vouch for,
 *   with no warning tier (mantahostels#103).
 * JUSTIFIED: fail-safe — a package's `preinstall` runs as the founder
 *   before anything reads it, and a hallucinated name can be pre-registered
 *   by anyone (Spracklen et al., USENIX Security 2025).
 * DEFEAT: `WFC_ALLOW_NEW_PACKAGE=1` in the environment Claude Code was
 *   started in stands down check 2 alone; the same assignment on the command
 *   line is read but never honoured (mantahostels#109). Nothing stands down
 *   check 1 or check 3. The founder running the install from their own
 *   terminal sees no hook.
 */

const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/npm-install.js");
const { buildHostPorts } = require("./lib/npm-install-host.js");

run({
	field: "command",
	noun: "command",
	onThrow: "refuse",
	decide,
	ports: buildHostPorts,
});
