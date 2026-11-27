const fs = require("node:fs");
const path = require("node:path");
const { relativeUnder } = require("./is-under.js");

/**
 * @param {string} root
 * @param {string} rel
 * @returns {string[]}
 */
function faultsOf(root, rel) {
	const { fileFaults } = require("../check-host-root.js");
	const { shipsPlugin } = require("./plugin-state.js");
	if (!shipsPlugin(root)) return [];
	const out = fileFaults(root, rel);
	if (fs.existsSync(path.join(__dirname, "plugin-tree.js"))) {
		const { bareCitationFaults } = require("./plugin-tree.js");
		out.push(...bareCitationFaults(root, rel));
	}
	return out;
}

/** @param {string} root @param {string} written */
function writeFaults(root, written) {
	const rel = relativeUnder(root, fs.realpathSync(path.resolve(root, written)));
	if (rel === null) return "";
	const faults = faultsOf(root, rel);
	if (faults.length === 0) return "";
	return `${rel} carries ${faults.length} fault(s) the commit gate or the release refuses — fix them now, before any test run (workflow-core#1151):\n${faults.join("\n")}`;
}

module.exports = { writeFaults };
