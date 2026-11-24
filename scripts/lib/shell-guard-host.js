const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { withoutLateEpipe } = require("./child-failure.js");
const { coreRoot } = require("./script-path.js");

// workflow-core#5383 measured triggers at 0.02-0.11 s
const TIMEOUT_MS = 9000;

/**
 * @param {unknown} [_env]
 * @param {string} [scripts]
 * @returns {import("./shell-guard.js").ShellGuardPorts}
 */
function buildHostPorts(_env, scripts = path.join(coreRoot(), "scripts")) {
	return {
		runShellGuard: (script, payload) => {
			const r = withoutLateEpipe(
				spawnSync("bash", [path.join(scripts, script)], {
					input: JSON.stringify(payload),
					encoding: "utf8",
					timeout: TIMEOUT_MS,
				}),
			);
			if (r.error || r.status !== 0)
				throw new Error(
					`${script}: ${r.error?.message ?? `exit ${r.status}`} ${r.stderr ?? ""}`.trim(),
				);
			return r.stdout;
		},
	};
}

module.exports = { buildHostPorts };
