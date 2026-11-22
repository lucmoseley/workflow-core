#!/usr/bin/env node
const { runHold } = require("./lib/review-hold.js");
const { buildHoldPorts } = require("./lib/review-hold-host.js");
const { writeFd } = require("./lib/write-fd.js");

const { parseOrExit } = require("./lib/cli-args.js");
const { scriptPath } = require("./lib/script-path.js");

/** @type {import("./lib/precommit-gates.js").Program} */
const PROGRAM = ({ cwd, env }) => {
	const { status, stderr } = runHold(buildHoldPorts({ cwd, env }));
	return { exit: status, stdout: "", stderr: stderr ?? "" };
};

module.exports = { PROGRAM };

if (require.main === module) {
	parseOrExit(process.argv.slice(2), {
		usage: `usage: review-hold-gate.js   (no arguments; the tree a commit carries is node ${scriptPath("commit-paths.js")} --tree's)\n`,
	});
	const { exit, stderr } = PROGRAM({ cwd: process.cwd(), env: process.env });
	if (stderr) writeFd(2, stderr);
	process.exit(exit);
}
