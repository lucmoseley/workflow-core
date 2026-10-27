/*
 * issue-phase-scope-host.js — the production ports guard-issue-phase-scope.js
 * wires into its core, lib/issue-phase-scope.js (#2798): the roadmap and the
 * called-cards register read off disk under the host root, which `run`
 * resolved, and the core paths spelt for an install.
 */

const fs = require("node:fs");
const path = require("node:path");

/**
 * @param {import("./kit-context.js").PortEnv} env
 * @returns {import("./issue-phase-scope.js").PhasePorts}
 */
const buildHostPorts = ({ root }) => ({
	readable: (rel) => {
		try {
			fs.accessSync(path.join(root, rel), fs.constants.R_OK);
			return true;
		} catch {
			return false;
		}
	},
	readFile: (rel) => fs.readFileSync(path.join(root, rel), "utf8"),
});

module.exports = { buildHostPorts };
