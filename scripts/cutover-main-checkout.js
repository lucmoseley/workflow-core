#!/usr/bin/env node
/*
 * cutover-main-checkout.js — the main checkout's one move to the worktree
 * model (#4248).
 *
 *   node scripts/cutover-main-checkout.js
 *     cuts over the main checkout of the repository the current directory is
 *     in, from it or from any linked worktree of it; run again, it reports
 *     the edits left there and runs a levelling pass
 *
 * check-landing-switch-on.js runs the same cutover at session start (#5276).
 *
 * In no family (§N3).
 *
 * The report goes to stderr. Exit 0 cut over, 1 refused or failed, 2 a usage
 * error.
 */

const path = require("node:path");
const { readAgentsForCutover } = require("./lib/agent-liveness.js");
const { scriptPath } = require("./lib/script-path.js");
const store = require("./lib/arbiter-store");
const { caught } = require("./lib/caught.js");
const { now } = require("./lib/check.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { cutover, renderCutover } = require("./lib/cutover.js");
const { GIT_TIMEOUT_MS, gitReader } = require("./lib/git.js");
const {
	renderBlocker,
	level,
	readOrphanedEdits,
	renderOutcome,
} = require("./lib/level-main.js");
const { mainCheckout } = require("./lib/main-checkout.js");
const { pidLock } = require("./lib/pid-lock.js");
const { cut, land } = require("./lib/session-checkout.js");
const { writeFd } = require("./lib/write-fd.js");

const CLI = { usage: `usage: node ${scriptPath("cutover-main-checkout.js")}` };

/* The scripts that run the cutover, either of which holds its lock. */
const HOLDERS = ["cutover-main-checkout.js", "check-landing-switch-on.js"];

/**
 * The cutover of the main checkout at `root`, run under a lock in its git
 * directory so two sessions starting at once never both cut it over, and
 * its report. A git or port that fails throws.
 * @param {string} root the main checkout
 * @returns {{ result: import("./lib/landing-switch-on.js").RunResult,
 *   lines: string[] }}
 */
function runCutover(root) {
	const read = gitReader(root, GIT_TIMEOUT_MS);
	const gitDir = read(["rev-parse", "--absolute-git-dir"], []);
	if (!gitDir.ok)
		throw new Error(`git cannot name ${root}'s git directory: ${gitDir.why}`);
	const lock = pidLock(
		path.join(gitDir.out.trim(), "wfc-cutover.pid"),
		HOLDERS,
	);
	if (!lock.acquire()) return { result: { status: "busy" }, lines: [] };
	try {
		const at = now();
		/** @param {string} rel */
		const lastWriter = (rel) => store.readLastWriterOf(rel, { root });
		const result = cutover(root, {
			listed: readAgentsForCutover,
			cut,
			land,
			orphanedEdits: (r) => readOrphanedEdits(r, at, lastWriter),
			level: (r) => level(r, { lastWriter, now: at }),
			gitIn: (dir) => gitReader(dir, GIT_TIMEOUT_MS),
		});
		const lines = renderCutover(result, {
			renderBlocker: (b) => renderBlocker(b, at),
			renderLevel: (o) => renderOutcome(o, at),
		});
		return { result, lines };
	} finally {
		lock.release();
	}
}

/**
 * @param {string[]} [argv]
 * @returns {number}
 */
function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, CLI);
	if (typeof parsed === "number") return parsed;
	const root = mainCheckout(process.cwd());
	if (root === null) {
		writeFd(2, "cutover: no main checkout holds this directory\n");
		return 1;
	}
	try {
		const { result, lines } = runCutover(root);
		writeFd(
			2,
			`${(result.status === "busy" ? ["refused: another run is cutting the main checkout over now"] : lines).join("\n")}\n`,
		);
		return result.status === "cut-over" ? 0 : 1;
	} catch (err) {
		writeFd(2, `cutover: failed: ${caught(err).message.trim()}\n`);
		return 1;
	}
}

if (require.main === module) process.exitCode = main();

module.exports = { main, runCutover };
