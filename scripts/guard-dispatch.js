#!/usr/bin/env node
/*
 * guard-dispatch.js — the one hook entry every always-on guard of an event
 * runs from as a core (workflow-core#2786, ADR-0010). The guard dispatcher, not subagent
 * dispatch (lib/dispatch-*.js).
 *
 * DENIES-THROUGH: lib/guard-judge.js — a core's deny, a store fault and a fail-closed core's throw reach the session merged, so the PreToolUse registration carries `"onFailure": "block"` and a crash refuses the call. The PostToolUse registration carries none: every core there fails open, and a PostToolUse exit cannot undo a call that already ran.
 *
 * LIMITS
 *  - With no node on PATH the hook line exits 0: every core is skipped,
 *    unlogged.
 *  - The hook line runs this entry from the pinned guard code through
 *    scripts/run-pinned-guards.js (lib/guard-code.js, workflow-core#4227), so a working copy's
 *    edit never reaches it. A fault in the kit there refuses every Bash,
 *    Write, Edit, NotebookEdit, Skill, Read, Glob, ListAgents, Agent and Task call
 *    until it is repaired: the shim refuses, naming the founder's repair, and
 *    a crash it cannot catch reaches `onFailure: block`. On PostToolUse the
 *    same fault silences every core there until it is repaired. A core module's own load fault is no kit
 *    fault: it gets that row's failure policy, the other cores still run, and
 *    it is logged under the core's name. An open core's fault therefore
 *    silences that core until it is fixed, and a fault in a lib several open
 *    cores require silences each of them.
 *  - The PostToolUse entry's 15 s timeout is the slowest hook's it replaced,
 *    scan-injection's: a hang in any core spends it for all of them.
 *  - Each core's own limits are in its module's header.
 */

const { parseOrExit } = require("./lib/cli-args.js");

const { flags } = parseOrExit(process.argv.slice(2), {
	usage:
		"Usage: guard-dispatch.js [--only <core>]   (the hook payload on stdin)",
	flags: { "--only": "value" },
});
const only = flags["--only"];
require("./lib/guard-dispatch.js").runDispatch(
	typeof only === "string" ? only : undefined,
);
