#!/usr/bin/env node
/*
 * test-gate.js — which gate runs the host's tests (#740): one answer, read by
 * .husky/pre-commit, commit-paths.js, check-test-marker.js and
 * guard-push-rules.sh (#758), so none of them can disagree on who owns a suite.
 *
 * "push" — the test-pass marker regime: pre-push warns on a sha with no green
 * marker, and never refuses (mantahostels#908). Where `suites` is on and the
 * declared command mints a marker, which today means it runs
 * scripts/run-vitest.js — or where `suites` is on and nothing is declared.
 *
 * "commit" — every other declared `commands.test`: pre-commit runs it and a
 * red refuses the commit.
 */

const fs = require("node:fs");
const path = require("node:path");
const config = require("./workflow-core-config.js");
const { caught } = require("./caught.js");
const { writeFd } = require("./write-fd.js");

const MINTER = /\brun-vitest\.js\b/;
/* `npm test`, `npm t`, `npm run[-script] <name>` — the script whose text is
 * what actually runs. */
const NPM_SCRIPT = /^npm\s+(?:(?:test|t)|run(?:-script)?\s+(\S+))(?=\s|$)/;

/**
 * @param {string} command
 * @param {string} root
 */
function mintsMarker(command, root) {
	const npm = NPM_SCRIPT.exec(command.trim());
	if (!npm) return MINTER.test(command);
	let scripts;
	try {
		scripts = JSON.parse(
			fs.readFileSync(path.join(root, "package.json"), "utf8"),
		).scripts;
	} catch {
		/* Unreadable reads as no marker, so pre-commit runs the npm command
		 * itself, and npm reports the broken package.json there. */
		return false;
	}
	const text = scripts?.[npm[1] ?? "test"];
	return typeof text === "string" && MINTER.test(text);
}

/**
 * Throws where the config cannot be read.
 * @param {{root?: string}} [opts]
 * @returns {{gate: "push"|"commit"|null, command: string|null}}
 */
function testGate(opts = {}) {
	const command = config.commandFor("test", opts);
	const suites = config.moduleOn("suites", opts);
	if (command === null) return { gate: suites ? "push" : null, command };
	if (suites && mintsMarker(command, opts.root ?? config.hostRoot()))
		return { gate: "push", command };
	return { gate: "commit", command };
}

/**
 * The one-line reason `want` does not own the host's tests.
 * @param {"push"|"commit"} want
 * @param {ReturnType<typeof testGate>} found
 */
function notGateLine(want, { gate, command }) {
	if (want === "commit" && command === null)
		return config.commandUndeclaredLine("test");
	if (gate === "push")
		return 'commands.test is gated at push by the test-pass marker — module "suites" is on and it runs scripts/run-vitest.js';
	if (gate === "commit")
		return "commands.test is gated at commit — it writes no test-pass marker, so a push has none to read";
	return config.moduleOffLine("suites");
}

/**
 * Why the push-time marker checks — the pre-push hook and `push:check` —
 * have nothing to judge, or null where the push gate owns the tests: `skip`
 * where the `suites` module is off or the tests are gated at commit,
 * `broken` where the config cannot be read (#814).
 * @param {{root?: string}} [opts]
 * @returns {{skip: string}|{broken: string}|null}
 */
function pushGateSkip(opts = {}) {
	try {
		if (!config.moduleOn("suites", opts))
			return { skip: config.moduleOffLine("suites") };
		const found = testGate(opts);
		return found.gate === "push" ? null : { skip: notGateLine("push", found) };
	} catch (e) {
		return { broken: caught(e).message };
	}
}

/* `node test-gate.js <commit|push>`: exit 0 where that gate owns the tests,
 * with the command on stdout where one is declared; the SKIP line and exit 1
 * where it does not; BROKEN and exit 2 on a config the reader refuses.
 * pre-commit reads `commit`, guard-push-rules.sh `push` (#758). */
if (require.main === module) {
	const want = process.argv.slice(2).join(" ");
	if (want !== "commit" && want !== "push") {
		writeFd(2, "usage: node test-gate.js <commit|push>\n");
		process.exit(2);
	}
	let found;
	try {
		found = testGate();
	} catch (e) {
		writeFd(2, `BROKEN: ${caught(e).message}\n`);
		process.exit(2);
	}
	if (found.gate !== want) {
		writeFd(2, `SKIP: ${notGateLine(want, found)}\n`);
		process.exit(1);
	}
	if (found.command !== null) writeFd(1, `${found.command}\n`);
}

module.exports = { pushGateSkip, testGate };
