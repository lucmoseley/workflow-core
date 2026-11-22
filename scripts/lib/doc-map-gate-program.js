#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { parseOrExit } = require("./cli-args.js");
const { Interrupted, realPorts } = require("./doc-map-gate-ports.js");
const { runDocMapGate } = require("./doc-map-gate.js");
const { writeFd } = require("./write-fd.js");

/** @type {import("./precommit-gates.js").Program} */
const PROGRAM = ({ cwd, env }) => {
	/** @type {string[]} */
	const made = [];
	try {
		const verdict = runDocMapGate(
			realPorts(
				path.resolve(cwd, env.WFC_PLUGIN_ROOT || ".", "scripts"),
				made,
				{
					cwd,
					env,
				},
			),
			{ allowDelete: !!env.WFC_ALLOW_GATE_INPUT_DELETE },
		);
		return { exit: verdict.exit, stdout: "", stderr: verdict.stderr };
	} catch (err) {
		if (!(err instanceof Interrupted)) throw err;
		return { exit: err.status, stdout: "", stderr: "" };
	} finally {
		for (const dir of made.splice(0))
			fs.rmSync(dir, { recursive: true, force: true });
	}
};

module.exports = { PROGRAM };

if (require.main === module) {
	parseOrExit(process.argv.slice(2), {
		usage: "usage: node doc-map-gate-program.js (takes no arguments)",
	});
	const { exit, stderr } = PROGRAM({ cwd: process.cwd(), env: process.env });
	if (stderr) writeFd(2, stderr);
	process.exit(exit);
}
