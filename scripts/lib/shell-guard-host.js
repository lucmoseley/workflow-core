/*
 * shell-guard-host.js — the production port the dispatcher wires into the
 * cores lib/shell-guard.js serves: a shell guard under scripts/ run on one
 * payload (workflow-core#5389).
 */

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { withoutLateEpipe } = require("./child-failure.js");
const { coreRoot } = require("./script-path.js");

/* The PreToolUse dispatcher entry gives all its cores 60 s together
 * (hooks/hooks.json). The scripts answer a trigger in 0.09-0.11 s
 * (browser-profile-guard.sh) and 0.02-0.03 s (practice-guard.sh), measured
 * at workflow-core#5383's review, so a run past 9 s is hung, and stopping it there leaves
 * the other cores most of the 60. The 9 s itself is a chosen margin between
 * those times and the 60 s, not a measurement. */
const TIMEOUT_MS = 9000;

/**
 * The dispatcher's env (lib/guard-judge.js) does not locate the scripts,
 * which ship with the core, so an adopter's root holding no scripts/ still
 * runs them (workflow-core#5425).
 * @param {unknown} [_env]
 * @param {string} [scripts] the directory the scripts are read from
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
