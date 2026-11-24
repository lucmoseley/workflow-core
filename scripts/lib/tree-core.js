const { spawnSync } = require("node:child_process");

const RESOLVE_CORE_SCRIPT = `
try {
  process.stdout.write(require("./scripts/lib/resolve-core.js").resolveCore());
} catch (err) {
  process.stderr.write(String(err instanceof Error ? err.message : err) + "\\n");
  process.exit(1);
}`;

class CoreUnresolved extends Error {}

/** @param {string} dir @param {number} timeoutMs @returns {string} */
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
