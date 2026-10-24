#!/usr/bin/env node
/*
 * check-format-staged.js — the pre-commit format gate's judge (#1332): it
 * refuses a staged shell or Python path that shfmt or `ruff format` would
 * change, as check:staged's Biome refuses unformatted JS and TS.
 *
 * Usage:
 *   node scripts/check-format-staged.js [--skip-shell] [--skip-python]
 *
 * Each path's STAGED blob is formatted, never the worktree copy: the commit
 * carries the blob, and in the shared tree a worktree read would judge a
 * neighbour's half-written edit. Unlike the ruff lint gate it charges the
 * whole file, not what the commit introduced — every tracked file was
 * formatted when the gate landed, so an unformatted one is this commit's.
 *
 * A formatter that is not installed is BROKEN: it is the checker's apparatus
 * (base §N4), and the refusal names the line that installs it. The hook
 * passes --skip-shell or --skip-python only where a workflow runs the missing
 * formatter (lib/formatters.js, #1354, #1463). Python's exclusions are ruff's
 * own (`--force-exclude`, `ruffExclude`); shell's are what the staged
 * .gitattributes marks vendored or generated (#1828).
 */

const path = require("node:path");
const { runCheck } = require("./lib/check");
const {
	RUFF,
	RUFF_INSTALL,
	SHFMT_INSTALL,
	indexHead,
	loadShfmt,
	ruffConfigArgs,
	ruffExcludeArgs,
	shellFiles,
	shellFinding,
} = require("./lib/formatters");
const { caught } = require("./lib/caught.js");
const { blob, spawn, stagedDiff } = require("./lib/staged");

/** @typedef {import("./lib/check").CheckContext} Ctx */
/**
 * @typedef {(tag: "UNFORMATTED" | "UNPARSEABLE", p: string, message: string) => void} Refuse
 * @typedef {{ staged: (p: string) => string, refuse: Refuse }} Judge
 */

/**
 * Formats each staged shell path's blob with shfmt, refusing what it would
 * change.
 *
 * @param {Ctx} ctx
 * @param {string[]} shell
 * @param {Judge} judge
 * @returns {number} the paths checked
 */
function checkShell(ctx, shell, { staged, refuse }) {
	if (shell.length === 0) return 0;
	const format = loadShfmt();
	if (!format)
		ctx.broken(
			`@wasm-fmt/shfmt is not installed for ${shell.length} staged shell path(s) — install it: ${SHFMT_INSTALL}`,
		);
	let checked = 0;
	for (const p of shell) {
		checked++;
		const finding = shellFinding(format, staged(p), p);
		if (finding) refuse(finding.tag, p, finding.message);
	}
	return checked;
}

/**
 * Runs `ruff format --check` over each staged Python path's blob, refusing
 * what it would change or cannot parse.
 *
 * @param {Ctx} ctx
 * @param {string[]} python
 * @param {Judge} judge
 * @returns {number} the paths checked
 */
function checkPython(ctx, python, { staged, refuse }) {
	if (python.length === 0) return 0;
	const base = [
		"format",
		"--check",
		...ruffConfigArgs(),
		...ruffExcludeArgs((line) => ctx.say(line)),
	];
	let checked = 0;
	for (const p of python) {
		const r = spawn(RUFF, [...base, "--stdin-filename", p, "-"], staged(p));
		if (r.error)
			ctx.broken(
				`cannot run ${RUFF} (${r.error.message}) for ${python.length} staged Python path(s) — install it: ${RUFF_INSTALL}`,
			);
		checked++;
		if (r.status === 1) refuse("UNFORMATTED", p, "not ruff-formatted");
		else if (r.status !== 0)
			refuse(
				"UNPARSEABLE",
				p,
				`ruff format exited ${r.status}: ${r.stderr.trim()}`,
			);
	}
	return checked;
}

/** check-shfmt.js, relative inside the repo, absolute from an adopter's plugin cache. */
function shfmtPath() {
	const abs = path.join(__dirname, "check-shfmt.js");
	const rel = path.relative(process.cwd(), abs);
	return rel.startsWith("..") ? abs : rel;
}

runCheck({
	name: "format-staged",
	usage: "node scripts/check-format-staged.js [--skip-shell] [--skip-python]",
	flags: ["--skip-shell", "--skip-python"],
	run(/** @type {Ctx} */ ctx) {
		const paths = stagedDiff(ctx, ["--name-only", "--diff-filter=ACMR"]);
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
		const staged = (p) => {
			const source = blob(`:${p}`);
			if (source === null) ctx.broken(`${p} has no staged blob`);
			return source;
		};

		/**
		 * @param {string[]} candidates
		 * @param {string} flag
		 * @param {string} why what the hook found missing, and its install
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

		let checked = checkShell(ctx, shell, { staged, refuse });
		checked += checkPython(ctx, python, { staged, refuse });

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
