#!/usr/bin/env node
/*
 * test-gate.js — which gate runs the host's tests (#740): one answer, read by
 * .husky/pre-commit, commit-paths.js, check-test-marker.js and
 * the guard-push-rules core (#758), so none of them can disagree on who owns a suite.
 *
 * "push" — the test-pass marker regime: pre-push warns on a sha no certificate
 * attests, and never refuses (mantahostels#908). Where `suites` is on and the
 * declared command mints a certificate, which today means it runs
 * scripts/run-vitest.js — or where `suites` is on and nothing is declared.
 *
 * "commit" — every other declared `commands.test`: pre-commit runs it and a
 * red refuses the commit.
 */

const fs = require("node:fs");
const path = require("node:path");
const config = require("./workflow-core-config.js");
const { caught } = require("./caught.js");
const { readCommittedFile } = require("./git-objects.js");
const { writeFd } = require("./write-fd.js");

const LANDER_LINE =
	'module "landing" is on — the lander runs the full suite before main moves, so no push owes a certificate';

const MINTER = /\brun-vitest\.js\b/;
/* `npm test`, `npm t`, `npm run[-script] <name>` — the script whose text is
 * what actually runs. */
const NPM_SCRIPT = /^npm\s+(?:(?:test|t)|run(?:-script)?\s+(\S+))(?=\s|$)/;

/**
 * Reads package.json as committed at `rev` where one is given, as the config
 * is read, and the working copy's otherwise (#3135). Throws where git cannot
 * read it at `rev`.
 * @param {string} command
 * @param {string} root
 * @param {string} [rev]
 */
function mintsMarker(command, root, rev) {
	const npm = NPM_SCRIPT.exec(command.trim());
	if (!npm) return MINTER.test(command);
	let committed;
	if (rev !== undefined)
		try {
			committed = readCommittedFile(rev, "package.json", { cwd: root });
		} catch (err) {
			throw new Error(
				`package.json at ${rev} cannot be read: ${caught(err).message}`,
				{ cause: err },
			);
		}
	if (committed === null) return false;
	let scripts;
	try {
		scripts = JSON.parse(
			committed ?? fs.readFileSync(path.join(root, "package.json"), "utf8"),
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
 * @param {import("./workflow-core-config.js").ConfigOpts} [opts]
 * @returns {{gate: "push"|"commit"|null, command: string|null}}
 */
function testGate(opts = {}) {
	const command = config.readCommandFor("test", opts);
	const suites = config.moduleOn("suites", opts);
	if (command === null) return { gate: suites ? "push" : null, command };
	if (suites && mintsMarker(command, opts.root ?? config.hostRoot(), opts.rev))
		return { gate: "push", command };
	return { gate: "commit", command };
}

/**
 * The one-line reason `want` does not own the host's tests.
 * @param {"push"|"commit"} want
 * @param {ReturnType<typeof testGate>} found
 */
function buildNotGateLine(want, { gate, command }) {
	if (want === "commit" && command === null)
		return config.buildCommandUndeclaredLine("test");
	if (gate === "push")
		return 'commands.test is gated at push by certificates — module "suites" is on and it runs scripts/run-vitest.js';
	if (gate === "commit")
		return "commands.test is gated at commit — it mints no certificate, so a push has none to read";
	return config.buildModuleOffLine("suites");
}

/**
 * Whether a push owes a certificate, for the push-time marker checks — the
 * pre-push hook, `push:check`, the push-rules guard's `push-green-suite` rule,
 * the `result:` refusal's session verdict and the unpushed-commits nudge. `owes`
 * where the push gate owns the tests; `skip` where the `suites` module is off,
 * the `landing` module is on, or the tests are gated at commit; `broken` where
 * the config cannot be read (#814, #2929, #2933). `line` says why, null on
 * `owes`. Callers switch on `state` and never read the shape otherwise (#3016).
 * @param {import("./workflow-core-config.js").ConfigOpts} [opts]
 * @returns {{state: "owes", line: null}
 *   | {state: "skip" | "broken", line: string}}
 */
function pushGateState(opts = {}) {
	try {
		if (!config.moduleOn("suites", opts))
			return { state: "skip", line: config.buildModuleOffLine("suites") };
		if (config.moduleOn("landing", opts))
			return { state: "skip", line: LANDER_LINE };
		const found = testGate(opts);
		return found.gate === "push"
			? { state: "owes", line: null }
			: { state: "skip", line: buildNotGateLine("push", found) };
	} catch (e) {
		return { state: "broken", line: caught(e).message };
	}
}

/* `node test-gate.js <commit|push>`: exit 0 where that gate owns the tests,
 * with the command on stdout where one is declared; the SKIP line and exit 1
 * where it does not; BROKEN and exit 2 on a config the reader refuses.
 * pre-commit reads `commit`, the guard-push-rules core `push` (#758). */
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
		writeFd(2, `SKIP: ${buildNotGateLine(want, found)}\n`);
		process.exit(1);
	}
	if (found.command !== null) writeFd(1, `${found.command}\n`);
}

module.exports = { pushGateState, testGate };
