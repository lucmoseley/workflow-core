#!/usr/bin/env node
/*
 * init-adopter.js — writes the day-one skeleton into a fresh repository (#5).
 * The logic is lib/init-adopter-core.js's, whose header gives the usage, the
 * order of the steps and the exits. This shell wires the core's ports to the
 * process — its streams, env and clock, the plugin scripts and gh as child
 * processes, the `claude plugin` install — and exits with what it returns.
 * cli-args-exempt: the core's own `parse` reads argv (its header says why).
 */

const { adopt } = require("./lib/init-adopter-core.js");
const { measurerFor } = require("./lib/core-context-cost.js");
const { ghBinary } = require("./lib/gh.js");
const { worktreeRoot } = require("./lib/host-root.js");
const { materialisePlugin, run } = require("./lib/materialise-plugin.js");
const { writeFd } = require("./lib/write-fd.js");

/** @type {import("./lib/init-adopter-core.js").Ports} */
const PORTS = {
	out: (text) => writeFd(1, text),
	err: (text) => writeFd(2, text),
	env: process.env,
	now: () => new Date(),
	defaultRoot: worktreeRoot,
	runNode: (root, script, args, opts) =>
		run(root, [process.execPath, script, ...args], opts),
	gh: (root, args) => run(root, [ghBinary(), ...args]),
	materialise: materialisePlugin,
	measurerFor,
};

module.exports = { PORTS };

if (require.main === module) process.exit(adopt(process.argv.slice(2), PORTS));
