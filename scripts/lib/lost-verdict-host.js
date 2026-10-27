/*
 * lost-verdict-host.js — the production ports guard-lost-verdict.js wires
 * into its core, lib/lost-verdict.js (workflow-core#2799).
 */

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
				/* Fails open to the built-in launches (mantahostels#103 §6). */
				log("suite runners unreadable", caught(e).message);
				return [];
			}
		},
		/* Only `other` launches read it, and this guard counts none. */
		isWrapperScript: () => true,
	};
}

module.exports = { buildHostPorts };
