/*
 * tree-core.js — the workflow-core a checkout's hook shim runs, asked through
 * that checkout's own scripts/lib/resolve-core.js as the shim asks it, so a
 * program judging the tree with core scripts judges it with the same core its
 * hook does (workflow-core#5314).
 */

const { spawnSync } = require("node:child_process");

/**
 * The `node -e` program a hook shim (adopter-skeleton.js renderHookShim)
 * finds its core with, run with the working tree's top as its cwd: the
 * core's directory on stdout, else exit 1 with the reason on stderr.
 */
const RESOLVE_CORE_SCRIPT = `
try {
  process.stdout.write(require("./scripts/lib/resolve-core.js").resolveCore());
} catch (err) {
  process.stderr.write(String(err instanceof Error ? err.message : err) + "\\n");
  process.exit(1);
}`;

/**
 * A tree whose hook shim would find no core: its hook refuses every commit
 * there.
 */
class CoreUnresolved extends Error {}

/**
 * The core the hook shim in the tree at `dir` runs, asked in a child so the
 * tree's code stays out of this process. Throws a CoreUnresolved carrying
 * the resolver's reason where it finds none. Throws the spawn's own error,
 * ETIMEDOUT past `timeoutMs` among them, where the child does not finish.
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
	if (r.error) throw r.error;
	if (r.status === 0 && r.stdout !== "") return r.stdout;
	const reason = r.stderr.trim().split("\n")[0] || `exit ${r.status}`;
	throw new CoreUnresolved(
		`its tree's scripts/lib/resolve-core.js finds no workflow-core to run its gate scripts with: ${reason}`,
	);
}

module.exports = { CoreUnresolved, RESOLVE_CORE_SCRIPT, resolveTreeCore };
