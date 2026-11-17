#!/usr/bin/env node
/*
 * test-gate.js — which gate runs the host's tests (#740): one answer, read by
 * .husky/pre-commit, commit-paths.js and check-session-draw.js, so none of
 * them can disagree on who owns a suite.
 *
 * "push" — the lander runs the full suite before main moves, and a commit runs
 * none: where the declared command has a fresh verdict proof
 * (lib/verdict-probe.js, #5294).
 *
 * "commit" — every other declared `commands.test`: pre-commit runs it and a
 * red refuses the commit.
 *
 * No gate — no `commands.test` is declared.
 */

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

/**
 * The tree the proof is keyed and probed in: the one being committed.
 * @param {import("./workflow-core-config.js").ConfigOpts} opts
 */
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

/**
 * What a proof is keyed on for the tree being committed, and the declared
 * command it is for. Throws where the config cannot be read.
 * @param {import("./workflow-core-config.js").ConfigOpts} opts
 */
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
 * Who owns the host's tests, reading the proof record and never probing.
 * Throws where the config cannot be read.
 * @param {import("./workflow-core-config.js").ConfigOpts} [opts]
 * @returns {TestGate}
 */
function testGate(opts = {}) {
	const at = proofInputs(opts);
	return gateFor(at.command, proofState(at));
}

/**
 * testGate, probing first where the record is stale and a canary is declared:
 * the answer pre-commit and commit-paths' pre-lock run act on. Throws where
 * the config cannot be read.
 * @param {(line: string) => void} say
 * @param {import("./workflow-core-config.js").ConfigOpts} [opts]
 * @returns {TestGate}
 */
function settleTestGate(say, opts = {}) {
	const at = proofInputs(opts);
	return gateFor(at.command, ensureProof({ ...at, say }));
}

/**
 * The one-line reason the gate asked for does not own the host's tests.
 * @param {TestGate} found
 */
function buildNotGateLine({ gate, command, proof }) {
	if (command === null) return config.buildCommandUndeclaredLine("test");
	if (gate === "push")
		return "commands.test is gated at push, where the lander runs the full suite — its verdict probe passed for this command, runner and canary";
	return buildStaysLine(proof);
}

/* `node test-gate.js <commit|push>`: exit 0 where that gate owns the tests,
 * with the command on stdout where one is declared; the SKIP line and exit 1
 * where it does not; BROKEN and exit 2 on a config the reader refuses.
 * Probes first where the proof is stale. pre-commit reads `commit`. */
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
