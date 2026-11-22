const { execFile, spawnSync } = require("node:child_process");
const path = require("node:path");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { coreRoot } = require("./script-path.js");

/**
 * @typedef {{error?: Error | null, stdout?: string | null, status: number | null}} CheckerRun
 */
/**
 * @typedef {{settle: () => Promise<CheckerRun>, stop: () => void}} Started
 */

const CHECKER_TIMEOUT_MS = {
	"check-primitives.js": 5 * 60 * 1000,
	// guess: 2.5x the worst run measured, #3771
	"check-idle-efforts.js": 3 * 60 * 1000,
	"check-wsl-currency.js": 4 * 60 * 1000,
};

/**
 * @param {string} script
 * @param {string[]} args
 */
const buildCheckerArgv = (script, args) => [
	path.join(coreRoot(), "scripts", script),
	"--json",
	...args,
];

/** @param {string} script */
const boundOf = (script) =>
	CHECKER_TIMEOUT_MS[/** @type {keyof typeof CHECKER_TIMEOUT_MS} */ (script)];

/**
 * @param {string} script
 * @param {string[]} args
 * @param {string} cwd
 */
function runChecker(script, args, cwd) {
	return spawnSync(process.execPath, buildCheckerArgv(script, args), {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: boundOf(script),
		maxBuffer: CHILD_MAX_BUFFER,
	});
}

/**
 * @param {string} script
 * @returns {Started}
 */
function startChecker(script) {
	const timeout = boundOf(script);
	const stop = new AbortController();
	/** @type {NodeJS.Timeout | undefined} */
	let bound;
	let ended = false;
	/** @type {Promise<CheckerRun>} */
	const answer = new Promise((resolve) => {
		const child = execFile(
			process.execPath,
			buildCheckerArgv(script, []),
			{ encoding: "utf8", maxBuffer: CHILD_MAX_BUFFER, signal: stop.signal },
			(error, stdout) => {
				ended = true;
				clearTimeout(bound);
				resolve({
					error: whyStartFailed(error, timeout),
					stdout,
					status: child.exitCode,
				});
			},
		);
		child.stdin?.end();
	});
	return {
		settle() {
			if (!ended) bound = setTimeout(() => stop.abort(), timeout);
			return answer;
		},
		stop: () => stop.abort(),
	};
}

/**
 * @param {import("node:child_process").ExecFileException | null} error
 * @param {number} timeout
 */
function whyStartFailed(error, timeout) {
	if (!error || typeof error.code === "number") return;
	if (error.name === "AbortError")
		return new Error(`killed at its ${timeout} ms bound`);
	if (error.signal) return new Error(`killed by ${error.signal}`);
	return error;
}

module.exports = { runChecker, startChecker };
