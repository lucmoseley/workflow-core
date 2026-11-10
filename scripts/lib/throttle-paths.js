/*
 * throttle-paths.js — where `check-self-throttling.js` keeps its state file,
 * kick stamp and reading history: one set per machine, never per repo root
 * (workflow-core#2098). The corpus swept is the whole machine's, so a per-root set makes
 * every fresh worktree, clone or pilot sandbox kick a sweep of its own.
 *
 * Each path yields to its `WFC_THROTTLE_*` override, which `run-arm-test.js`
 * sets to the host's paths so a sandbox at a revision older than workflow-core#2098, whose
 * script still defaults per root, shares the machine's sweep too.
 */

const fs = require("node:fs");
const path = require("node:path");
const { machineMarkerPath } = require("./machine-marker.js");
const { markersDir } = require("./marker-root.js");
const { hostRoot } = require("./host-root.js");

/**
 * The host's markers directory only where HOME is unusable, so a session
 * start still has somewhere to read from.
 *
 * @param {string} name
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
function machineFile(name, env) {
	try {
		const file = machineMarkerPath(name, env);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		return file;
	} catch {
		return path.join(markersDir(hostRoot()), name);
	}
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
const stateFile = (env = process.env) =>
	env.WFC_THROTTLE_STATE || machineFile(".self-throttling-state.json", env);

/**
 * When a sweep was last KICKED, which is a different fact from when one last
 * FINISHED: a sweep that dies leaves no state file, and without this the
 * no-state branch is taken again at the very next session start.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
const refreshStamp = (env = process.env) =>
	env.WFC_THROTTLE_REFRESH_STAMP || `${stateFile(env)}.refresh`;

/**
 * Every sweep's reading, appended one JSON line at a time.
 *
 * WHY A HISTORY AND NOT ONLY THE LATEST SWEEP. The corpus this reads is
 * PERISHABLE: Claude Code rolls transcripts off this machine at about 30 days,
 * so an episode leaves every future sweep once its transcripts age out
 * (mantahostels#1404). The state file holds the newest sweep alone, so without this there is no way
 * to reconstruct what normal looked like BEFORE capacity was cut, which is the
 * only comparison that answers the ladder's "have I cut too far".
 *
 * MACHINE-LOCAL AND NOT REGENERABLE: rebuilding this WSL2 guest loses it, and
 * no sweep can recover a line, the transcripts behind it being gone.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
const historyFile = (env = process.env) =>
	env.WFC_THROTTLE_HISTORY ||
	machineFile(".self-throttling-history.jsonl", env);

/**
 * The overrides that pin a child to this process's paths.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {Record<string, string>}
 */
const throttleEnv = (env = process.env) => ({
	WFC_THROTTLE_STATE: stateFile(env),
	WFC_THROTTLE_REFRESH_STAMP: refreshStamp(env),
	WFC_THROTTLE_HISTORY: historyFile(env),
});

module.exports = { historyFile, refreshStamp, stateFile, throttleEnv };
