#!/usr/bin/env node
/*
 * doc-map-gate-program.js — the doc map's own coverage, checked at commit as
 * well as in roadmap-digest.yml (mantahostels#390): the pre-commit dispatcher's
 * doc-map row (#5172). PROGRAM wires lib/doc-map-gate-ports.js's production
 * adapters to lib/doc-map-gate.js's core (#5155).
 *
 * Usage: node lib/doc-map-gate-program.js   (no arguments; its cwd the repo's top)
 *
 * It runs the checker at "${WFC_PLUGIN_ROOT:-.}"/scripts/, as the hook spells
 * every core script, so an adopter's shim reaches the plugin's copy (#1839).
 *
 * IMPLICIT:  on a commit touching the doc map's scope, refuses one adding a doc-map fault HEAD does not carry, deleting the map, or adding a register row or Section C route for a file the commit does not carry.
 * JUSTIFIED: fail-safe — a doc map that stops telling the truth misleads every session that checks it before an edit, and the sweeps catch it only after the push.
 * DEFEAT:    WFC_ALLOW_GATE_INPUT_DELETE=1 lets the map's deletion through (the founder's to set, #916); a fault HEAD already carries passes by design (mantahostels#1688); an untracked item whose path appears anywhere in HEAD's map passes as inherited.
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseOrExit } = require("./cli-args.js");
const { Interrupted, realPorts } = require("./doc-map-gate-ports.js");
const { runDocMapGate } = require("./doc-map-gate.js");
const { writeFd } = require("./write-fd.js");

/**
 * The gate over the index of the repo at `cwd`, as the pre-commit dispatcher
 * runs it in its own process (#5172). A hook signal that ends a child makes
 * 128 + n the exit, as sh's trap did.
 * @type {import("./precommit-gates.js").Program}
 */
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
