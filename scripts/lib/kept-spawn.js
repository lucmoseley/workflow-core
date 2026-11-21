/*
 * kept-spawn.js — a test's spawn of node on the program under test, with the
 * reason docs/code-standards-base.md §X3 keeps it as a typed value (#5483).
 *
 * `keptSpawn("fd").spawnSync(process.execPath, [script], options)` is
 * child_process's own `spawnSync`.
 * scripts/check-test-spawn.js passes a spawn of node in a test only when it is
 * called this way.
 */

const {
	spawn,
	spawnSync,
	execFile,
	execFileSync,
} = require("node:child_process");

/** @type {readonly SpawnReason[]} */
const REASONS = Object.freeze([
	"timeout",
	"signal",
	"concurrent",
	"fd",
	"boundary",
]);

/**
 * Why a test runs the program as a real process, not through runInProcess:
 * - `timeout`: the case runs on the real clock — it kills a run that hangs,
 *   or times a real wait — which in-process cannot bound.
 * - `signal`: the case sends the run a signal.
 * - `concurrent`: two or more processes run at once.
 * - `fd`: the run needs a real fd — a pipe, a closed or full stream, an fd a
 *   child inherits.
 * - `boundary`: the process itself is the subject — its own fresh state, an
 *   entry runInProcess cannot load, or a real run held as another's comparand.
 *
 * @typedef {"timeout" | "signal" | "concurrent" | "fd" | "boundary"} SpawnReason
 */

/**
 * @param {SpawnReason} reason
 * @returns {Pick<typeof import("node:child_process"), "spawn" | "spawnSync" | "execFile" | "execFileSync">}
 * @throws where `reason` is not a SpawnReason
 */
function keptSpawn(reason) {
	if (!REASONS.includes(reason))
		throw new TypeError(
			`keptSpawn: "${reason}" is not a spawn reason; one of ${REASONS.join(", ")}.`,
		);
	return { spawn, spawnSync, execFile, execFileSync };
}

module.exports = { keptSpawn, REASONS };
