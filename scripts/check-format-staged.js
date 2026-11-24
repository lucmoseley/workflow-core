#!/usr/bin/env node
const path = require("node:path");
const { runCheck } = require("./lib/check");
const {
	RUFF,
	RUFF_INSTALL,
	SHFMT_INSTALL,
	indexHead,
	loadShfmt,
	ruffConfigArgs,
	readRuffExcludeArgs,
	shellFiles,
	shellFinding,
} = require("./lib/formatters");
const { caught } = require("./lib/caught.js");
const { readBlob, spawn, readStagedDiff } = require("./lib/staged");
const { relativeUnder } = require("./lib/is-under.js");
const { scriptPath } = require("./lib/script-path.js");

/** @typedef {import("./lib/check").Ctx} Ctx */
/**
 * @typedef {(tag: "UNFORMATTED" | "UNPARSEABLE", p: string, message: string) => void} Refuse
 * @typedef {{ readStagedBlob: (p: string) => string, refuse: Refuse }} Judge
 * @typedef {import("node:child_process").SpawnSyncReturns<string>} RuffRun
 */

/**
 * @param {Ctx} ctx
 * @param {string[]} shell
 * @param {Judge} judge
 * @returns {number}
 */
function checkShell(ctx, shell, { readStagedBlob, refuse }) {
	if (shell.length === 0) return 0;
	const format = loadShfmt();
	if (!format)
		ctx.broken(
			`@wasm-fmt/shfmt is not installed for ${shell.length} staged shell path(s) — install it: ${SHFMT_INSTALL}`,
		);
	let checked = 0;
	for (const p of shell) {
		checked++;
		const finding = shellFinding(format, readStagedBlob(p), p);
		if (finding) refuse(finding.tag, p, finding.message);
	}
	return checked;
}

/**
 * @param {Ctx} ctx
 * @param {string[]} python
 * @param {Judge} judge
 * @returns {number}
 */
function checkPython(ctx, python, { readStagedBlob, refuse }) {
	if (python.length === 0) return 0;
	const base = [
		"format",
		"--check",
		...ruffConfigArgs(),
		...readRuffExcludeArgs((line) => ctx.say(line)),
	];
	let checked = 0;
	for (const p of python) {
		const args = [...base, "--stdin-filename", p, "-"];
		const r = spawn(RUFF, args, readStagedBlob(p));
		if (r.error)
			ctx.broken(
				`cannot run ${RUFF} (${r.error.message}) for ${python.length} staged Python path(s) — install it: ${RUFF_INSTALL}`,
			);
		checked++;
		if (r.status === 1) refuse("UNFORMATTED", p, "not ruff-formatted");
		else if (r.status !== 0) {
			const toolFault = readRuffToolFault(r, args);
			if (toolFault)
				ctx.broken(
					`${RUFF} format cannot run: ${toolFault}\nFix its config, or reinstall it: ${RUFF_INSTALL}`,
				);
			refuse(
				"UNPARSEABLE",
				p,
				`ruff format exited ${r.status}: ${r.stderr.trim()}`,
			);
		}
	}
	return checked;
}

/**
 * workflow-core#3825
 * @param {RuffRun} failed
 * @param {string[]} args
 * @returns {string}
 */
function readRuffToolFault(failed, args) {
	const died = readRunDeath(failed);
	if (died) return died;
	const empty = spawn(RUFF, args, "");
	const rerunDied = readRunDeath(empty);
	if (rerunDied) return rerunDied;
	if (empty.status === 0) return "";
	return empty.stderr.trim() || `exited ${empty.status} on an empty blob`;
}

/**
 * @param {RuffRun} run
 * @returns {string}
 */
function readRunDeath(run) {
	if (run.error) return run.error.message;
	return run.signal ? `killed by ${run.signal}` : "";
}

function shfmtPath() {
	const abs = path.join(__dirname, "check-shfmt.js");
	return relativeUnder(process.cwd(), abs) ?? abs;
}

runCheck({
	name: "format-staged",
	usage: `node ${scriptPath("check-format-staged.js")} [--skip-shell] [--skip-python]`,
	flags: ["--skip-shell", "--skip-python"],
	run(/** @type {Ctx} */ ctx) {
		const paths = readStagedDiff(ctx, ["--name-only", "--diff-filter=ACMR"]);
		let allShell;
		try {
			allShell = shellFiles(paths, indexHead(), { cached: true });
		} catch (e) {
			ctx.broken(caught(e).message);
		}
		const allPython = paths.filter((p) => p.endsWith(".py"));
		if (allShell.length + allPython.length === 0)
			return { okLine: "no staged shell or Python path" };

		/** @param {string} p */
		const readStagedBlob = (p) => {
			const source = readBlob(`:${p}`);
			if (source === null) ctx.broken(`${p} has no staged blob`);
			return source;
		};

		/**
		 * @param {string[]} candidates
		 * @param {string} flag
		 * @param {string} why
		 */
		const skip = (candidates, flag, why) => {
			if (!ctx.has(flag)) return candidates;
			if (candidates.length > 0)
				ctx.say(
					`SKIPPED ${candidates.length} path(s) at ${flag}: ${why}. This commit is NOT blocked on them.`,
				);
			return [];
		};
		const shell = skip(
			allShell,
			"--skip-shell",
			`@wasm-fmt/shfmt is not installed, and a workflow runs it — ${SHFMT_INSTALL}`,
		);
		const python = skip(
			allPython,
			"--skip-python",
			`${RUFF} is not on PATH, and a workflow runs it — ${RUFF_INSTALL}`,
		);

		let refused = 0;
		/** @type {Refuse} */
		const refuse = (tag, p, message) => {
			refused++;
			ctx.fail(tag, `${p}: ${message}`, { path: p });
			ctx.say(`${p}: ${message}`);
		};

		let checked = checkShell(ctx, shell, { readStagedBlob, refuse });
		checked += checkPython(ctx, python, { readStagedBlob, refuse });

		if (checked === 0) ctx.skip("every staged shell and Python path skipped");
		if (refused > 0) {
			ctx.say(
				`Fix: node ${shfmtPath()} --write <path> for shell, ruff format <path> for Python, then restage.`,
			);
			return { noun: "unformatted path(s)", count: refused };
		}
		return { okLine: `${checked} staged shell and Python path(s) formatted` };
	},
});
