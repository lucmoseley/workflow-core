/*
 * sweep-fire-host.js — the production port lib/sweep-fire.js spends through
 * (workflow-core#2790): one unit of the day's sweep budget off lib/sweep-budget.js, the
 * counter the autofire also writes, in the host root's git common dir.
 *
 * Every fault comes back as a `fault` — a git that will not name a common
 * dir, a marker that will not read or write, a clock that is not a date, a
 * budget module that will not load — never a throw: a budget that cannot be
 * counted refuses nothing (mantahostels#103 §6), and a throw would take the
 * core's fail-closed policy instead. The module loads on first spend, so a
 * Bash call that fires no sweep pays nothing and a module mid-save is a fault
 * here rather than a crash of the entry.
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
		 * @param {string | undefined} now `WFC_NOW`, which pins the clock as it
		 *   does for check-ci-status.js; the wall clock where unset
		 * @returns {Spend}
		 */
		spendSweep: (now) => {
			try {
				const t = now ? Date.parse(now) : Date.now();
				if (Number.isNaN(t)) return { fault: `WFC_NOW is not a date: ${now}` };
				return load().spendHandFire(root, t);
			} catch (e) {
				return { fault: caught(e).message };
			}
		},
	};
}

module.exports = { buildHostPorts };
