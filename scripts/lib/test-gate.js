#!/usr/bin/env node

const config = require("./workflow-core-config.js");
const { worktreeRoot } = require("./host-root.js");
const { markersDir } = require("./marker-root.js");
const {
	buildStaysLine,
	ensureProof,
	proofState,
} = require("./verdict-probe.js");
const { caught } = require("./caught.js");
const { writeFd } = require("./write-fd.js");

/**
 * @typedef {{gate: "push"|"commit"|null, command: string|null,
 *   proof: import("./verdict-probe.js").ProofState}} TestGate
 */

/** @param {import("./workflow-core-config.js").ConfigOpts} opts */
const treeOf = (opts) => opts.root ?? worktreeRoot();

/**
 * @param {string|null} command
 * @param {import("./verdict-probe.js").ProofState} proof
 * @returns {TestGate}
 */
function gateFor(command, proof) {
	if (command === null) return { gate: null, command, proof };
	return { gate: proof.state === "fresh" ? "push" : "commit", command, proof };
}

/** @param {import("./workflow-core-config.js").ConfigOpts} opts */
function proofInputs(opts) {
	const { commands, testCanary } = config.readConfig(opts);
	return {
		root: treeOf(opts),
		command: commands.test,
		canary: testCanary,
		markers: markersDir(opts.root),
	};
}

/**
 * @param {import("./workflow-core-config.js").ConfigOpts} [opts]
 * @returns {TestGate}
 */
function testGate(opts = {}) {
	const at = proofInputs(opts);
	return gateFor(at.command, proofState(at));
}

/**
 * @param {(line: string) => void} say
 * @param {import("./workflow-core-config.js").ConfigOpts} [opts]
 * @returns {TestGate}
 */
function settleTestGate(say, opts = {}) {
	const at = proofInputs(opts);
	return gateFor(at.command, ensureProof({ ...at, say }));
}

/** @param {TestGate} found */
function buildNotGateLine({ gate, command, proof }) {
	if (command === null) return config.buildCommandUndeclaredLine("test");
	if (gate === "push")
		return "commands.test is gated at push, where the lander runs the full suite — its verdict probe passed for this command, runner and canary";
	return buildStaysLine(proof);
}

if (require.main === module) {
	const want = process.argv.slice(2).join(" ");
	if (want !== "commit" && want !== "push") {
		writeFd(2, "usage: node test-gate.js <commit|push>\n");
		process.exit(2);
	}
	let found;
	try {
		found = settleTestGate((line) => writeFd(2, `${line}\n`));
	} catch (e) {
		writeFd(2, `BROKEN: ${caught(e).message}\n`);
		process.exit(2);
	}
	if (found.gate !== want) {
		writeFd(2, `SKIP: ${buildNotGateLine(found)}\n`);
		process.exit(1);
	}
	if (found.gate === "commit") writeFd(2, `${buildStaysLine(found.proof)}\n`);
	if (found.command !== null) writeFd(1, `${found.command}\n`);
}

module.exports = { settleTestGate, testGate };
