/*
 * core-fault.js — the words a fail-closed core's deny opens with where the
 * kit could not run it (lib/guard-dispatch.js), which the guard code's probe
 * reads as the code at fault (lib/guard-code.js, #4227). A leaf, so the probe
 * need not load the kit.
 */

const CORE_FAULT_TEXT = "could not judge this call";

module.exports = { CORE_FAULT_TEXT };
