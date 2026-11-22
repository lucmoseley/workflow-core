const fs = require("node:fs");
const { caught } = require("./caught.js");
const { readRuns } = require("./test-log.js");
const { repoRoot } = require("./test-pass-marker.js");
const { readConfig } = require("./workflow-core-config.js");

/**
 * @param {import("./kit-context.js").PortEnv} env
 * @returns {import("./lost-verdict.js").VerdictPorts}
 */
function buildHostPorts({ root, payload, log }) {
	const logRoot = repoRoot(root) ?? root;
	return {
		payload,
		logRoot,
		readRuns: (session) => readRuns(logRoot, session),
		readFile: (file) => fs.readFileSync(file, "utf8"),
		now: Date.now,
		runners: () => {
			try {
				return readConfig({ root, quiet: true }).suiteRunners ?? [];
			} catch (e) {
				log("suite runners unreadable", caught(e).message);
				return [];
			}
		},
		isWrapperScript: () => true,
	};
}

module.exports = { buildHostPorts };
