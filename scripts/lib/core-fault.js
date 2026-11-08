/*
 * core-fault.js — the words a refusal opens with where no guard judged the
 * call: a fail-closed core's deny where the kit could not run it
 * (lib/guard-judge.js), which the guard code's probe reads as the code at
 * fault (lib/guard-code.js, #4227), and the pinned-guard shim's where the code
 * it runs is missing or throws (scripts/run-pinned-guards.js). The refill
 * loop reads a session refused only so as locked out (lib/block-cause.js,
 * #4228). A leaf, so neither reader need load the kit.
 */

const CORE_FAULT_TEXT = "could not judge this call";

/* The shim's openings, copied there, as it requires nothing of the repo's;
 * scripts/run-pinned-guards.test.ts holds the two together. */
const SHIM_FAULT_TEXTS = /** @type {const} */ ([
	"Guard code missing",
	"Guard code failed in ",
]);

const LOCKOUT_TEXTS = [CORE_FAULT_TEXT, ...SHIM_FAULT_TEXTS];

module.exports = { CORE_FAULT_TEXT, LOCKOUT_TEXTS, SHIM_FAULT_TEXTS };
