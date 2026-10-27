#!/usr/bin/env node
/*
 * guard-cpu-load.js — PreToolUse guard: refuse a CPU load generator that runs
 * outside a CPU cap, and hand over the capped form (#2710). The core, with
 * its WHY, what counts as a generator and as a cap, and its LIMITS, is
 * lib/cpu-load.js; its ports lib/cpu-load-host.js, where `WFC_CPU_COUNT`, read
 * from the HOOK's environment, sets the core count for the tests.
 *
 * DENIES-THROUGH: lib/guard-entry.js — `run` writes the core's deny, so the
 * registration carries `"onFailure": "block"` and a crash or timeout refuses.
 *
 * FAILS CLOSED on a core that throws (lib/refuse-on-throw.js). Every input it
 * cannot resolve still fails open, recorded (mantahostels#103 §6,
 * mantahostels#147): a core count that does not resolve allows every command,
 * and a taskset affinity it cannot read is taken as a cap.
 *
 * LIMITS
 *  - Wired with `if: Bash(*yes*)`, `Bash(*stress*)`, `Bash(*done*)`,
 *    `Bash(*.sh*)` and `Bash(*sh -*)`. A script is read only where its name
 *    ends `.sh`, the narrowing.
 *  - It guards the Bash tool. Load started outside Claude Code sees no hook.
 */

const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/cpu-load.js");
const { buildHostPorts } = require("./lib/cpu-load-host.js");

run({
	field: "command",
	noun: "command",
	onThrow: "refuse",
	decide,
	ports: buildHostPorts,
});
