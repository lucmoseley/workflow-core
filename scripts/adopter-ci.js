#!/usr/bin/env node
/*
 * adopter-ci.js — the one job of an adopter's core-owned CI workflow
 * (lib/adopter-ci.js renders it, #5347): the repo's own declared commands,
 * then every shipped tree check whose gate holds here.
 *
 * THE COMMANDS run in the order `check`, `lint`, `typecheck`, `test`, each
 * declared one under `sh -c`, as the lander's local tester runs `test`.
 *
 * THE CHECKS are the registry's `check` entries that need no tracker and are
 * not core-only (lib/repo-checks-registry.js): the daily repo-checks run's
 * tree half, which reads the checkout alone. Its tracker half needs a token
 * the job does not hold. A check exits 1 on FAIL and 2 when BROKEN
 * (lib/check.js); WARN and SKIP exit 0 and fail nothing.
 *
 * EVERY STEP RUNS, whatever the one before it returned, so no failure masks
 * another; the run exits 1 where any failed, naming each.
 *
 * IN NO SCRIPT FAMILY (§N3): it launches commands and checkers and judges
 * them by exit code alone.
 *
 * IMPLICIT: the workflow's `Commands and shipped checks` step, in an adopter
 * whose config carries `ci`.
 */

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { hostRoot } = require("./lib/host-root.js");
const { isCoreHost } = require("./lib/plugin-state.js");
const { REPO_CHECKS, gateFault } = require("./lib/repo-checks-registry.js");
const { coreRoot } = require("./lib/script-path.js");
const { readConfig } = require("./lib/workflow-core-config.js");
const { writeFd } = require("./lib/write-fd.js");

/** @type {readonly import("./lib/workflow-core-config.js").Command[]} */
const CI_COMMANDS = ["check", "lint", "typecheck", "test"];

/**
 * Runs one step inside an Actions log group.
 * @param {string} title
 * @param {string} file
 * @param {string[]} args
 * @param {string} cwd
 * @returns {number} its exit code, 1 where it ran to none
 */
function step(title, file, args, cwd) {
	writeFd(1, `::group::${title}\n`);
	const r = spawnSync(file, args, { cwd, stdio: "inherit" });
	writeFd(1, "::endgroup::\n");
	if (r.error) writeFd(2, `${title}: ${r.error.message}\n`);
	return r.status ?? 1;
}

/**
 * @param {string} root
 * @param {import("./lib/workflow-core-config.js").Config} cfg
 * @returns {string[]} the title of each command that failed
 */
function runCommands(root, cfg) {
	/** @type {string[]} */
	const failed = [];
	for (const name of CI_COMMANDS) {
		const line = cfg.commands[name];
		if (!line) continue;
		const title = `commands.${name}: ${line}`;
		if (step(title, "sh", ["-c", line], root) !== 0) failed.push(title);
	}
	return failed;
}

/**
 * @param {string} root
 * @param {import("./lib/workflow-core-config.js").Config} cfg
 * @returns {string[]} the title of each check that failed
 */
function runChecks(root, cfg) {
	/** @type {import("./lib/repo-checks-registry.js").Host} */
	const host = {
		root,
		file: path.relative(root, cfg.file),
		core: isCoreHost(root),
		modules: new Set(cfg.modules),
		config: /** @type {Record<string, unknown>} */ (cfg),
		tracker: () => null,
	};
	/** @type {string[]} */
	const failed = [];
	for (const entry of REPO_CHECKS) {
		if (entry.kind !== "check" || entry.gate.tracker || entry.gate.core)
			continue;
		const fault = gateFault(entry, host);
		if (fault) {
			writeFd(1, `skipped ${entry.id}: ${fault}\n`);
			continue;
		}
		const script = path.join(coreRoot(), "scripts", entry.script);
		const title = `check ${entry.id}`;
		const args = [script, ...(entry.args ?? [])];
		if (step(title, process.execPath, args, root) !== 0) failed.push(title);
	}
	return failed;
}

function main() {
	const root = hostRoot();
	const cfg = readConfig({ root, quiet: true });
	const failed = [...runCommands(root, cfg), ...runChecks(root, cfg)];
	if (failed.length === 0) {
		writeFd(1, "adopter-ci: every step passed\n");
		return 0;
	}
	writeFd(2, `adopter-ci: ${failed.length} failed:\n`);
	for (const f of failed) writeFd(2, `  ${f}\n`);
	return 1;
}

process.exitCode = main();
