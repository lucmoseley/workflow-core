#!/usr/bin/env node
// workflow-core#5654
const path = require("node:path");
const { ignoreFailure } = require("./lib/caught.js");
const { sweepScratch } = require("./lib/scratch-sweep.js");

ignoreFailure(() => {
	const core = require("./lib/arbiter-core");
	const { listedAgents } = require("./lib/agent-liveness");
	const { hostRoot } = require("./lib/host-root.js");
	sweepScratch({
		dir: process.env.WFC_SCRATCH_DIR || path.join(hostRoot(), ".claude", "tmp"),
		readAgents: () => listedAgents({ requireSelf: false }),
		logError: core.logError,
	});
});
process.exit(0);
