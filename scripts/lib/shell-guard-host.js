/*
 * shell-guard-host.js — the production port the dispatcher wires into the
 * cores lib/shell-guard.js serves: a shell guard under scripts/ run on one
 * payload (#5389).
 */

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { coreRoot } = require("./script-path.js");

/* The PreToolUse dispatcher entry gives all its cores 60 s together
 * (hooks/hooks.json). The scripts answer a trigger in 0.09-0.11 s
 * (browser-profile-guard.sh) and 0.02-0.03 s (practice-guard.sh), three runs
 * each on 2026-11-17 (#5383's review), so a run past 9 s is hung, and stopping
 * it there leaves the other cores most of the 60. */
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
