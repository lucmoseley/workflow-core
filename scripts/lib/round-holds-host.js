/*
 * round-holds-host.js — the production ports the dispatcher wires into the
 * guard-round-holds core, lib/round-holds.js (workflow-core#3858). lib/repo-holds.js loads
 * only for a round, as this core sits on every `gh` call.
 */

const { readBodyFile } = require("./body-file.js");
const os = require("node:os");
const { isMarkersWritable } = require("./refuse-once.js");

/**
 * @param {string} root
 * @returns {import("./round-holds.js").RoundHoldPorts}
 */
function buildHostPorts(root) {
	return {
		home: os.homedir(),
		readFile: readBodyFile,
		isLatchWritable: () => isMarkersWritable(root),
		readHoldLines: () => {
			const holds = require("./repo-holds.js");
			return holds.buildHoldLines([holds.readCheckout(root)], Date.now());
		},
	};
}

module.exports = { buildHostPorts };
