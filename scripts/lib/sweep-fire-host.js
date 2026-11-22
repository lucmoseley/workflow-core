const { caught } = require("./caught.js");

/**
 * @typedef {{ out: boolean, spent: number, cap: number, day: string }
 *   | { fault: string }} Spend
 */

/**
 * @param {{ root: string }} env
 * @param {() => typeof import("./sweep-budget.js")} [load]
 */
function buildHostPorts({ root }, load = () => require("./sweep-budget.js")) {
	return {
		/**
		 * @param {Record<string, string | undefined>} env
		 * @returns {Spend}
		 */
		spendSweep: (env) => {
			try {
				return load().spendFire(root, require("./check.js").now(env));
			} catch (e) {
				return { fault: caught(e).message };
			}
		},
	};
}

module.exports = { buildHostPorts };
