/*
 * sweep-fire-host.js — the production port lib/sweep-fire.js spends through
 * (#2790): one unit of the day's sweep budget off lib/sweep-budget.js, the
 * counter the autofire also writes, in the host root's git common dir.
 *
 * Every fault comes back as a `fault` — a git that will not name a common
 * dir, a marker that will not read or write, a `WFC_NOW` pin `now()` will not
 * parse, a budget module that will not load — never a throw: a budget that cannot be
 * counted refuses nothing (mantahostels#103 §6), and a throw would take the
 * core's fail-closed policy instead. The budget module and lib/check.js's
 * `now()` load on first spend, so a Bash call that fires no sweep pays nothing
 * and a module mid-save is a fault here rather than a crash of the entry.
 */

const { caught } = require("./caught.js");

/**
 * @typedef {{ out: boolean, spent: number, cap: number, day: string }
 *   | { fault: string }} Spend
 */

/**
 * @param {string} root
 * @param {unknown} _log
 * @param {() => typeof import("./sweep-budget.js")} [load] the budget
 *   module; a case hands in one that will not load
 */
function buildHostPorts(root, _log, load = () => require("./sweep-budget.js")) {
	return {
		/**
		 * @param {Record<string, string | undefined>} env the core's, whose
		 *   `WFC_NOW` pins the clock
		 * @returns {Spend}
		 */
		spendSweep: (env) => {
			try {
				return load().spendHandFire(root, require("./check.js").now(env));
			} catch (e) {
				return { fault: caught(e).message };
			}
		},
	};
}

module.exports = { buildHostPorts };
