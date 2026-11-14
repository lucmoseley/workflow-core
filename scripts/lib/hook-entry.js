/*
 * hook-entry.js — what every git-hook dispatcher's entry wires before it
 * calls lib/precommit-dispatch.js (#5172, #5207): the signal catch (#5188)
 * and the hook's git directory.
 */

const { constants } = require("node:os");
const { spawnGitSync } = require("./git.js");

/**
 * Catches SIGINT, SIGTERM and SIGHUP for the rest of the process, and answers
 * the dispatcher's `interrupted` port: the first caught signal's 128 + n,
 * else null. A listener fires only between event-loop turns, so the port
 * yields one turn before it answers. A second signal exits at once, its
 * row's cleanup unrun, as the way out of a row that will not return.
 * @returns {() => Promise<number | null>}
 */
function catchSignals() {
	/** @type {number | null} */
	let code = null;
	/** @param {NodeJS.Signals} name */
	const record = (name) => {
		if (code !== null) process.exit(code);
		code = 128 + constants.signals[name];
	};
	for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(name, record);
	return () => new Promise((resolve) => setImmediate(() => resolve(code)));
}

/**
 * The hook's absolute git directory, "" where git will not name one: the
 * empty directory lib/commit-route.js reads as no marker at all.
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} [env]
 */
function hookGitDir(cwd, env = process.env) {
	const r = spawnGitSync(["rev-parse", "--absolute-git-dir"], {
		cwd,
		env,
		encoding: "utf8",
	});
	return r.status === 0 && !r.error ? String(r.stdout).trim() : "";
}

module.exports = { catchSignals, hookGitDir };
