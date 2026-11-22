const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { markersDir } = require("./marker-root.js");
const { reviewOwed } = require("./push-review.js");
const { readConfig } = require("./workflow-core-config.js");

/**
 * @param {import("./core-contract.js").HostEnv} env
 * @returns {import("./push-rules.js").PushPorts}
 */
function buildHostPorts({ root, log }) {
	return {
		reviewOwed: (tree, sessionId) => reviewOwed({ sessionId, tree, log }),
		markerSum: (sessionId) => {
			if (!sessionId) return "";
			try {
				const marker = fs.readFileSync(
					path.join(markersDir(root), `.codereview-pass-${sessionId}`),
				);
				return crypto.createHash("sha256").update(marker).digest("hex");
			} catch {
				return "";
			}
		},
		deploysVercel: () => {
			try {
				return readConfig({ root, quiet: true }).deploy === "vercel";
			} catch {
				return false;
			}
		},
	};
}

module.exports = { buildHostPorts };
