#!/usr/bin/env node
/*
 * guard-rm-unchecked.js — PreToolUse guard: refuse, once per command, an `rm`
 * Claude Code's built-in removal check cannot resolve, naming the two
 * spellings that never meet it (#2436). The core, with its three limbs and
 * LIMITS, is lib/unchecked-rm.js; its ports lib/unchecked-rm-host.js.
 *
 * REFUSES ONCE a target opening on a variable the command never sets, a
 * relative glob after a `cd`, and any `rm` beside a shell running a `-c`
 * script or a variable's script.
 *
 * DENIES-THROUGH: lib/guard-entry.js — `run` writes the core's deny, then the
 * latch (mantahostels#2261). The registration carries `onFailure: block`,
 * so a crash or timeout of the entry refuses the call.
 *
 * FAILS OPEN, logged, on a core that throws and on every input it cannot
 * resolve, the latch's key and directory included.
 *
 * LIMITS
 *  - Wired with `if: Bash(*rm *)`, unanchored because the `if` tests quoted
 *    argument text, where a `bash -c` script's `rm` sits, and splits on `;`
 *    but not on a loop's `do`, so an anchored arm misses
 *    `for …; do rm …; done`.
 */

const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/unchecked-rm.js");
const { buildHostPorts } = require("./lib/unchecked-rm-host.js");

run({ field: "command", noun: "command", decide, ports: buildHostPorts });
