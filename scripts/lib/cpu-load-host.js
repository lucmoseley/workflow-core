/*
 * cpu-load-host.js — the production ports the dispatcher wires into the
 * guard-cpu-load core, lib/cpu-load.js (workflow-core#2801, workflow-core#3224).
 *
 * The core count is the online count, as `getconf _NPROCESSORS_ONLN` gives
 * it, and not os.availableParallelism(): that is the hook's own affinity, so
 * a session started under `taskset` would read its cap as the machine.
 */

const fs = require("node:fs");
const os = require("node:os");

/** @returns {import("./cpu-load.js").CpuLoadPorts} */
function buildHostPorts() {
	return {
		/* `WFC_CPU_COUNT`, read from the HOOK's environment, sets the count
		 * for the tests; it is no escape (mantahostels#109). */
		coreCount: () => process.env.WFC_CPU_COUNT || String(os.cpus().length),
		readScript: (p, maxBytes) => {
			try {
				const st = fs.statSync(p);
				if (!st.isFile() || st.size > maxBytes) return null;
				return fs.readFileSync(p, "utf8");
			} catch {
				return null;
			}
		},
	};
}

module.exports = { buildHostPorts };
