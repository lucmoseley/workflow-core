/*
 * shell-guard-host.js — the production port the dispatcher wires into the
 * cores lib/shell-guard.js serves: a shell guard under scripts/ run on one
 * payload (#5389).
 */

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { coreRoot } = require("./script-path.js");

/* Under the 10 s the guards' own hook entries gave them. */
const TIMEOUT_MS = 9000;

/** @returns {import("./shell-guard.js").ShellGuardPorts} */
function buildHostPorts() {
	return {
		runShellGuard: (script, payload) => {
			const r = spawnSync("bash", [path.join(coreRoot(), "scripts", script)], {
				input: JSON.stringify(payload),
				encoding: "utf8",
				timeout: TIMEOUT_MS,
			});
			if (r.error || r.status !== 0)
				throw new Error(
					`${script}: ${r.error?.message ?? `exit ${r.status}`} ${r.stderr ?? ""}`.trim(),
				);
			return r.stdout;
		},
	};
}

module.exports = { buildHostPorts };
