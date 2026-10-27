#!/usr/bin/env node
/*
 * guard-wide-read.js — PreToolUse guard: this Bash command reads a whole
 * file, a wide `sed -n` slice or an uncounted glob back into the context
 * window (mantahostels#1562). The core, with its WHY and LIMITS, is
 * lib/wide-read.js; its `Read` limb runs from the dispatcher's
 * `guard-wide-read` row instead, over the same core.
 *
 * WARNS only, never denies.
 *
 * FAILS OPEN on every fault, recorded (mantahostels#103 §6, mantahostels#147):
 * lib/guard-entry.js's `run` allows a payload it cannot read and a core that
 * throws.
 *
 * LIMITS
 *  - Its narrowings, `if: Bash(*cat *)`, `if: Bash(*sed *)` and
 *    `if: Bash(*awk *)`, are unanchored, so a `cat` behind a launcher or a
 *    later segment starts it. A command holding `cat`, `sed` or `awk` with no
 *    space after it never starts this.
 *
 * It answers under the dispatcher row's name, so one `disabled` entry,
 * `guard-wide-read`, silences both limbs (#569).
 */

const { run } = require("./lib/guard-entry.js");
const { decide, noun } = require("./lib/wide-read.js");
const { buildHostPorts } = require("./lib/wide-read-host.js");

run({
	/* The Bash limbs alone: the Read limb's `file_path` is the dispatcher
	 * row's. */
	field: "command",
	name: "guard-wide-read",
	noun,
	decide,
	ports: () => ({ ...buildHostPorts(), env: process.env }),
});
