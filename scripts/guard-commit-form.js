#!/usr/bin/env node
/*
 * guard-commit-form.js — PreToolUse guard on the commit forms
 * (mantahostels#117). The core is lib/commit-form.js.
 *
 * DENIES the sweeping, `--no-verify`, `--amend` and closing-keyword forms;
 * WARNS on staging, a bare commit, a pathspec sweeping a neighbour's claim and
 * an untracked pathspec; otherwise hands the commit rules over once a session.
 *
 * DENIES-THROUGH: lib/guard-entry.js — `run` writes the core's deny, so the
 * registration carries `"onFailure": "block"` and a crash or timeout refuses.
 *
 * FAILS CLOSED on a core that throws (lib/refuse-on-throw.js). Every input it
 * cannot resolve still fails open, recorded (mantahostels#103 §6,
 * mantahostels#147).
 *
 * LIMITS
 *  - Wired with `if: Bash(git *)` (mantahostels#2127) — not started unless
 *    some segment of the command leads with `git` — and again with
 *    `if: Bash(*commit-paths.js*)` (#2022), unanchored because that call leads
 *    with `node`, so it also starts on a `cat` naming the file, which it
 *    allows.
 *  - It guards the Bash tool. A commit from the founder's own terminal sees no
 *    hook.
 */

const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/commit-form.js");
const { buildHostPorts } = require("./lib/commit-form-host.js");

run({
	field: "command",
	noun: "command",
	onThrow: "refuse",
	decide,
	ports: buildHostPorts,
});
