/*
 * tree-core.js — the workflow-core a checkout's hook shim runs, asked through
 * that checkout's own scripts/lib/resolve-core.js as the shim asks it, so a
 * program judging the tree with core scripts judges it with the same core its
 * hook does (#5314).
 */

const { spawnSync } = require("node:child_process");
const { RESOLVE_CORE_SCRIPT } = require("./adopter-skeleton.js");
const { caught } = require("./caught.js");
const { TransientFault } = require("./queue-lander.js");

/**
 * A tree whose hook shim would find no core: its hook refuses every commit
 * there, so what it holds is refused, never judged by another core.
 */
class CoreUnresolved extends Error {}

/**
 * The core the hook shim in the tree at `dir` runs, asked in a child so the
 * tree's code stays out of this process. Throws a CoreUnresolved carrying
 * the resolver's reason where it finds none, and a TransientFault where it
 * outruns `timeoutMs`.
 * @param {string} dir
 * @param {number} timeoutMs
 * @returns {string}
 */
function resolveTreeCore(dir, timeoutMs) {
	const r = spawnSync(process.execPath, ["-e", RESOLVE_CORE_SCRIPT], {
		cwd: dir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: timeoutMs,
	});
	if (caught(r.error).code === "ETIMEDOUT")
		throw new TransientFault(
			`resolving its tree's workflow-core timed out after ${timeoutMs / 1000} s`,
			{ cause: r.error },
		);
	if (r.error) throw r.error;
	if (r.status === 0 && r.stdout !== "") return r.stdout;
	const reason = r.stderr.trim().split("\n")[0] || `exit ${r.status}`;
	throw new CoreUnresolved(
		`its tree's scripts/lib/resolve-core.js finds no workflow-core to run its gate scripts with: ${reason}`,
	);
}

module.exports = { CoreUnresolved, resolveTreeCore };
