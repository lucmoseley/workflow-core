/*
 * issue-phase-scope-host.js — the production ports the dispatcher wires into
 * the guard-issue-phase-scope core, lib/issue-phase-scope.js (workflow-core#2798, workflow-core#3225):
 * the roadmap and the called-cards register read off disk under the tree
 * the core names, the session's (workflow-core#4242).
 */

const fs = require("node:fs");
const path = require("node:path");

/**
 * @returns {import("./issue-phase-scope.js").PhasePorts}
 */
const buildHostPorts = () => ({
	readable: (tree, rel) => {
		try {
			fs.accessSync(path.join(tree, rel), fs.constants.R_OK);
			return true;
		} catch {
			return false;
		}
	},
	readFile: (tree, rel) => fs.readFileSync(path.join(tree, rel), "utf8"),
});

module.exports = { buildHostPorts };
