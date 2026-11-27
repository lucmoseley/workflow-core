const { constants } = require("node:os");

/**
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

const GIT_REDIRECTS = ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE"];

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
function scrubbedGitEnv(env) {
	const out = { ...env };
	for (const key of GIT_REDIRECTS) delete out[key];
	return out;
}

/** @typedef {{ hook: string, said: "threw" | "did not run", exit: number }} Crash */

// workflow-core#5207
/**
 * @param {Crash} crash
 * @param {unknown} e
 */
function crashLine({ hook, said }, e) {
	let message;
	try {
		message = require("./caught.js").caught(e).message;
	} catch {
		message = e instanceof Error ? e.message : String(e);
	}
	return `${hook}: the dispatcher ${said}: ${message.split("\n")[0]}\n`;
}

/** @param {string} line
 */
function writeCrashLine(line) {
	/** @type {(fd: number, text: string) => void} */
	let write;
	try {
		write = require("./write-fd.js").writeFd;
	} catch {
		write = (fd, text) => require("node:fs").writeSync(fd, text);
	}
	write(2, line);
}

/**
 * @param {() => Promise<number>} main
 * @param {Crash} crash
 */
function exitWhenSettled(main, crash) {
	main().then(
		(code) => process.exit(code),
		(e) => {
			try {
				writeCrashLine(crashLine(crash, e));
			} finally {
				process.exit(crash.exit);
			}
		},
	);
}

module.exports = {
	catchSignals,
	exitWhenSettled,
	readHookGitDir,
	scrubbedGitEnv,
};
