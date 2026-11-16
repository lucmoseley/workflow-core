/*
 * cutover-run.js — the main checkout's cutover, run under its lock (#5276).
 */

const path = require("node:path");
const { readAgentsForCutover } = require("./agent-liveness.js");
const store = require("./arbiter-store");
const { now } = require("./check.js");
const { cutover, renderCutover } = require("./cutover.js");
const { GIT_TIMEOUT_MS, gitReader } = require("./git.js");
const {
	renderBlocker,
	level,
	readOrphanedEdits,
	renderOutcome,
} = require("./level-main.js");
const { pidLock } = require("./pid-lock.js");
const { cut, land } = require("./session-checkout.js");

/* The scripts that run the cutover, either of which holds its lock. */
const HOLDERS = ["cutover-main-checkout.js", "check-main-checkout-cutover.js"];

/**
 * The cutover of the main checkout at `root`, run under a lock in its git
 * directory so two sessions starting at once never both cut it over, and
 * its report. A git or port that fails throws.
 * @param {string} root
 * @returns {{ result: import("./main-checkout-cutover.js").RunResult,
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

module.exports = { runCutover };
