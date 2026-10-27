/*
 * issue-create-label-host.js — the production ports guard-issue-create-label.js
 * wires into its core, lib/issue-create-label.js (#2796). gh carries 3 s a
 * call: the edit route's two fetches cost 6 s at worst under the hook's 10 s,
 * and the second-map list is never spent beside them.
 */

const fs = require("node:fs");
const { gh } = require("./gh.js");

const GH_TIMEOUT_MS = 3000;

/** @returns {import("./issue-create-label.js").LabelPorts} */
const buildHostPorts = () => ({
	readFile: (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined),
	gh: (args, cwd) => gh(args, { cwd, timeout: GH_TIMEOUT_MS }),
});

module.exports = { buildHostPorts };
