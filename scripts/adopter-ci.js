#!/usr/bin/env node
/*
 * adopter-ci.js — the one job of an adopter's core-owned CI workflow
 * (lib/adopter-ci.js renders it, workflow-core#5347): the repo's own declared commands,
 * then every shipped tree check whose gate holds here.
 *
 * THE COMMANDS: `check`, `lint` and `typecheck`, each declared one under
 * `sh -c`; then the whole suite exactly as the lander's local tester runs
 * it on a clean checkout (lib/local-tester.js `readRunsAt`): `full_test`,
 * else `test`, its shards in turn, and the plugin's pytest runner where the
 * config routes a Python test path. A `test` that narrows to unpushed work
 * selects nothing here, so such a repo declares `full_test`.
 *
 * THE CHECKS are the registry's `check` entries whose gate holds here
 * (lib/repo-checks-registry.js): the daily repo-checks run's tree half.
 *
 * EVERY STEP RUNS, whatever the one before it returned, so no failure masks
 * another.
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
const { readRunsAt } = require("./lib/local-tester.js");
const {
	REPO_CHECKS,
	gateFault,
	readHost,
} = require("./lib/repo-checks-registry.js");
const { coreRoot } = require("./lib/script-path.js");
const { readConfig } = require("./lib/workflow-core-config.js");
const { writeFd } = require("./lib/write-fd.js");

/** @type {readonly import("./lib/workflow-core-config.js").Command[]} */
const CI_COMMANDS = ["check", "lint", "typecheck"];

/**
 * Runs one step inside an Actions log group.
 * @param {string} title
 * @param {string} file
 * @param {string[]} args
 * @param {{cwd: string, env?: Record<string, string>}} at
 * @returns {number} its exit code, 1 where it ran to none
 */
function step(title, file, args, { cwd, env = {} }) {
	writeFd(1, `::group::${title}\n`);
	const r = spawnSync(file, args, {
		cwd,
		stdio: "inherit",
		env: { ...process.env, ...env },
	});
	writeFd(1, "::endgroup::\n");
	if (r.error) writeFd(2, `${title}: ${r.error.message}\n`);
	return r.status ?? 1;
}

/**
 * @param {string} root
 * @param {import("./lib/workflow-core-config.js").Config} cfg
 * @returns {string[]} the title of each command or suite run that failed
 */
function runCommands(root, cfg) {
	/** @type {{title: string, command: string, args: string[],
	 *   env?: Record<string, string>}[]} */
	const runs = [];
	for (const name of CI_COMMANDS) {
		const line = cfg.commands[name];
		if (line)
			runs.push({
				title: `commands.${name}: ${line}`,
				command: line,
				args: [],
			});
	}
	const pytest = path.join(coreRoot(), "scripts", "run-pytest.js");
	const suite = readRunsAt(root, pytest, [], () => null);
	/** @type {string[]} */
	const failed = [];
	if (typeof suite === "string") failed.push(`the test suite: ${suite}`);
	else
		for (const run of suite.flat())
			runs.push({
				...run,
				title: `suite: ${run.label ?? run.command}`,
			});
	for (const { title, command, args, env } of runs) {
		const argv = ["-c", `${command} "$@"`, "adopter-ci", ...args];
		if (step(title, "sh", argv, { cwd: root, env }) !== 0) failed.push(title);
	}
	return failed;
}

/**
 * @param {string} root
 * @returns {string[]} the title of each check that failed
 */
function runChecks(root) {
	/* No token on the job: every tracker entry is SKIP. */
	const host = readHost(root, () => null);
	/** @type {string[]} */
	const failed = [];
	for (const entry of REPO_CHECKS) {
		if (entry.kind !== "check") continue;
		const fault = gateFault(entry, host);
		if (fault) {
			writeFd(1, `skipped ${entry.id}: ${fault}\n`);
			continue;
		}
		const script = path.join(coreRoot(), "scripts", entry.script);
		const title = `check ${entry.id}`;
		const args = [script, ...(entry.args ?? [])];
		if (step(title, process.execPath, args, { cwd: root }) !== 0)
			failed.push(title);
	}
	return failed;
}

function main() {
	const root = hostRoot();
	const cfg = readConfig({ root, quiet: true });
	const failed = [...runCommands(root, cfg), ...runChecks(root)];
	if (failed.length === 0) {
		writeFd(1, "adopter-ci: every step passed\n");
		return 0;
	}
	writeFd(2, `adopter-ci: ${failed.length} failed:\n`);
	for (const f of failed) writeFd(2, `  ${f}\n`);
	return 1;
}

process.exitCode = main();
