/*
 * machine-marker.js — where a marker that is one per machine lives:
 * `~/.claude/<name>`, the one config directory every plan's settings share,
 * outside any checkout.
 */

const path = require("node:path");

/**
 * `env.HOME`, never `os.homedir()`: `scripts/burn-mode.sh` finds the plans it
 * writes under `$HOME`, and a marker resolved any other way could end up
 * outside the settings files burn mode's marker is the restore record for.
 * Untrimmed, because that scan does not trim it either.
 *
 * ABSOLUTE OR NOTHING: a relative HOME would re-scope the marker per working
 * directory, which is per-checkout by another name.
 *
 * @param {string} name the marker's file name
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 * @throws where HOME is unset or relative — the caller decides what silence
 *   costs
 */
function machineMarkerPath(name, env) {
	const home = env.HOME || "";
	if (!path.isAbsolute(home)) throw new Error("HOME unset or not absolute");
	return path.join(home, ".claude", name);
}

module.exports = { machineMarkerPath };
