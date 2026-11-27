const fs = require("node:fs");
const os = require("node:os");

/** @returns {import("./cpu-load.js").CpuLoadPorts} */
function buildHostPorts() {
	return {
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
