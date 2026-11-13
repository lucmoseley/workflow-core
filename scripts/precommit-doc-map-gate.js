#!/usr/bin/env node
/*
 * precommit-doc-map-gate.js — the doc map's own coverage, checked at commit as
 * well as in roadmap-digest.yml (mantahostels#390). The shell of lib/doc-map-gate.js,
 * whose header holds the gate's rules; .husky/pre-commit calls it when the
 * commit touches the map's scope.
 *
 * Usage: node precommit-doc-map-gate.js   (no arguments; run by the hook, its
 * cwd the repo's top)
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
const { parseArgs } = require("node:util");
const { runDocMapGate } = require("./lib/doc-map-gate.js");
const { realPorts } = require("./lib/doc-map-gate-ports.js");
const { writeFd } = require("./lib/write-fd.js");

try {
	parseArgs({ args: process.argv.slice(2), options: {}, strict: true });
} catch {
	writeFd(2, "usage: node precommit-doc-map-gate.js (takes no arguments)\n");
	process.exit(2);
}

/** @type {string[]} */
const made = [];
function cleanup() {
	for (const dir of made.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
}

for (const [signal, code] of /** @type {const} */ ([
	["SIGHUP", 129],
	["SIGINT", 130],
	["SIGTERM", 143],
]))
	process.on(signal, () => {
		cleanup();
		process.exit(code);
	});

let verdict;
try {
	verdict = runDocMapGate(
		realPorts(path.join(process.env.WFC_PLUGIN_ROOT || ".", "scripts"), made),
		{ allowDelete: !!process.env.WFC_ALLOW_GATE_INPUT_DELETE },
	);
} finally {
	cleanup();
}
writeFd(2, verdict.stderr);
process.exit(verdict.exit);
