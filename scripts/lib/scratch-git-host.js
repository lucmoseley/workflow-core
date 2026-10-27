/*
 * scratch-git-host.js — the production ports lib/scratch-git.js reads through
 * the dispatcher (workflow-core#3162): a script's text, by absolute path, since a probe's
 * script may sit outside the repository where readText cannot reach; and
 * whether the repository holding the script tracks it, asked from the
 * script's own directory so a sibling repository's tracked script is known.
 */

const fs = require("node:fs");
const path = require("node:path");
const { HOOK_GIT_TIMEOUT_MS, spawnGitSync } = require("./git.js");

/* A guess, not a measurement: a probe script is tens of lines, and this repo's
 * largest tracked shell script, bg-run.sh, is 66 KiB (27 Oct 2026), so past
 * four times that it is no probe. */
const READ_CAP = 256 * 1024;

function buildHostPorts() {
	return {
		/** @param {string} abs @returns {string | null} */
		readScript: (abs) => {
			try {
				if (fs.statSync(abs).size > READ_CAP) return null;
				return fs.readFileSync(abs, "utf8");
			} catch {
				/* Unreadable is the core's logged allow, the house fail-open
				 * (mantahostels#103 §6). */
				return null;
			}
		},
		/** @param {string} abs @returns {boolean | null} */
		isTracked: (abs) => {
			const r = spawnGitSync(
				["ls-files", "--error-unmatch", "--", path.basename(abs)],
				{
					cwd: path.dirname(abs),
					timeout: HOOK_GIT_TIMEOUT_MS,
					stdio: "ignore",
				},
			);
			if (r.status === 0) return true;
			/* 1 is an untracked file; 128 is no repository at all, which tracks
			 * nothing. Anything else — a timeout, a missing git — cannot say. */
			if (r.status === 1 || r.status === 128) return false;
			return null;
		},
	};
}

module.exports = { buildHostPorts };
