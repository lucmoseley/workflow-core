const { readBodyFile } = require("./body-file.js");
const { gh } = require("./gh.js");

// guess, workflow-core#2796
const GH_TIMEOUT_MS = 3000;

/** @returns {import("./issue-create-label.js").LabelPorts} */
const buildHostPorts = () => ({
	readFile: readBodyFile,
	gh: (args, cwd) => gh(args, { cwd, timeout: GH_TIMEOUT_MS }),
	now: () => Date.now(),
});

module.exports = { buildHostPorts };
