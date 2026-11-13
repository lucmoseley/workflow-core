#!/usr/bin/env node
/*
 * init-adopter.js — writes the day-one skeleton into a fresh repository (#5).
 * The logic is lib/init-adopter-core.js's, whose header gives the usage, the
 * order of the steps and the exits. This shell wires the core's ports to the
 * process — its two streams, and the plugin scripts run as child processes —
 * and exits with what it returns.
 * cli-args-exempt: the core's own `parse` reads argv (its header says why).
 */

const { adopt } = require("./lib/init-adopter-core.js");
const { run } = require("./lib/materialise-plugin.js");
const { writeFd } = require("./lib/write-fd.js");

process.exit(
	adopt(process.argv.slice(2), {
		out: (text) => writeFd(1, text),
		err: (text) => writeFd(2, text),
		runNode: (root, script, args, opts) =>
			run(root, [process.execPath, script, ...args], opts),
	}),
);
