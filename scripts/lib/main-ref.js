/*
 * main-ref.js — whether the shared `main` is broken rather than moved (workflow-core#3198).
 *
 * `git rev-parse --verify` failing on a ref file that exists is the ruling's
 * proof. Its `^{commit}` form is not used: a ref naming a lost object still reads,
 * so it counts as moved, and stays the guard's case. A git that never ran or was
 * cut off proves nothing, so answers "unknown", which no caller may write on.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnGitSync } = require("./git.js");

const MAIN_REF = "refs/heads/main";

/**
 * @param {string} commonDir  the checkout's shared `.git`
 * @param {number} timeout  each caller's own git ceiling: a git with none hangs the caller
 * @returns {"unreadable"|"readable"|"no-ref-file"|"unknown"}
 */
function readMainState(commonDir, timeout) {
	if (!fs.existsSync(path.join(commonDir, MAIN_REF))) return "no-ref-file";
	const r = spawnGitSync(
		["--git-dir", commonDir, "rev-parse", "--verify", MAIN_REF],
		{ stdio: "ignore", timeout },
	);
	if (r.error || r.status === null) return "unknown";
	return r.status === 0 ? "readable" : "unreadable";
}

module.exports = { MAIN_REF, readMainState };
