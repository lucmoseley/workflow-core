/*
 * issue-phase-scope-host.js — the production ports the dispatcher wires into
 * the guard-issue-phase-scope core, lib/issue-phase-scope.js (#2798, #3225):
 * the roadmap and the called-cards register read off disk under the host
 * root, and the core paths spelt for an install.
 */

const fs = require("node:fs");
const path = require("node:path");

/**
 * @param {string} root
 * @returns {import("./issue-phase-scope.js").PhasePorts}
 */
const buildHostPorts = (root) => ({
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
