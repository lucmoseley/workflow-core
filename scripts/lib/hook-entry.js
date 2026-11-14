/*
 * hook-entry.js — what every git-hook dispatcher's entry wires around its
 * call to lib/precommit-dispatch.js (#5172, #5207): the signal catch
 * (#5188), the hook's git directory, the hook's environment less git's
 * redirects, and the exit once the run settles.
 *
 * lib/git.js is loaded at the first read, not with this file, so an entry's
 * crash line still prints where git.js itself will not load.
 */

const { constants } = require("node:os");
const { caught } = require("./caught.js");
const { writeFd } = require("./write-fd.js");

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
 * @returns {string}
 */
function readHookGitDir(cwd, env = process.env) {
	const { spawnGitSync } = require("./git.js");
	const r = spawnGitSync(["rev-parse", "--absolute-git-dir"], {
		cwd,
		env,
		encoding: "utf8",
	});
	return r.status === 0 && !r.error ? String(r.stdout).trim() : "";
}

/* The variables git exports into a hook that redirect a read: GIT_INDEX_FILE
 * — a RELATIVE `.git/index` — into every hook, GIT_DIR into a commit's in a
 * linked worktree, and GIT_WORK_TREE, the third of the class. A git call made
 * from a cwd of its own under them reads the wrong index or the hook's gitdir. */
const GIT_REDIRECTS = ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE"];

/**
 * `env` without the variables git exports into a hook that redirect a read.
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
function scrubbedGitEnv(env) {
	const out = { ...env };
	for (const key of GIT_REDIRECTS) delete out[key];
	return out;
}

/**
 * Runs an entry's `main` and exits with the code it settles on. Where it
 * throws, prints one line naming the hook and the fault's first line, and
 * exits `exit`.
 * @param {() => Promise<number>} main
 * @param {{ hook: string, said: "threw" | "did not run", exit: number }} crash
 *   `said`, what the line says the dispatcher did; `exit`, the crash's code
 */
function exitWhenSettled(main, { hook, said, exit }) {
	main().then(
		(code) => process.exit(code),
		(e) => {
			writeFd(
				2,
				`${hook}: the dispatcher ${said}: ${caught(e).message.split("\n")[0]}\n`,
			);
			process.exit(exit);
		},
	);
}

module.exports = {
	catchSignals,
	exitWhenSettled,
	readHookGitDir,
	scrubbedGitEnv,
};
