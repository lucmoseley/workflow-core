#!/usr/bin/env node
/*
 * guard-root-find.js — PreToolUse guard: refuse a `find` whose start point is
 * `/`, at any depth, and hand over the cheaper routes (workflow-core#1006). The core, with
 * its WHY and LIMITS, is lib/find-start.js.
 *
 * DENIES a `find` started at `/` — `//`, `/tmp/..` and a relative start from
 * a cwd of `/` included.
 *
 * DENIES-THROUGH: lib/guard-entry.js — `run` writes the core's deny, so the
 * registration carries `"onFailure": "block"` and a crash or timeout refuses.
 *
 * FAILS CLOSED on a core that throws (lib/refuse-on-throw.js). Every input it
 * cannot resolve still fails open, recorded (mantahostels#103 §6,
 * mantahostels#147).
 *
 * LIMITS
 *  - Its `if: Bash(*find *)` narrowing is unanchored, because the walk strips
 *    launchers (`timeout 120 find /`) that an anchored arm would miss. A
 *    command holding `find` with no space after it never starts this.
 */

const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/find-start.js");
const { buildHostPorts } = require("./lib/find-start-host.js");

run({
	field: "command",
	noun: "command",
	onThrow: "refuse",
	decide,
	ports: buildHostPorts,
});
