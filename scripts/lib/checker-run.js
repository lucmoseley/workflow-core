/*
 * checker-run.js — a core checker's `--json` run, as scripts/file-morning-review.js
 * runs it (#5148). lib/checker-run-fake.ts answers the same two ports from
 * recorded envelopes; checker-run.contract.test.ts holds it to these.
 */

const { execFile, spawnSync } = require("node:child_process");
const path = require("node:path");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { coreRoot } = require("./script-path.js");

/**
 * A checker's run: an error where it did not finish, its stdout and exit.
 * @typedef {{error?: Error | null, stdout?: string | null, status: number | null}} CheckerRun
 */
/**
 * @typedef {{settle: () => Promise<CheckerRun>, stop: () => void}} Started
 */

/** Each checker's bound, in ms. */
const CHECKER_TIMEOUT_MS = {
	/* Untraced: the count line runs every enforcing check over the whole tree. */
	"check-primitives.js": 5 * 60 * 1000,
	/* One paged GraphQL read per tracker, run side by side: 2.5x the worst run
	 * #3771 measured, the multiplier a guess, and well inside
	 * refill-review-run.js's REVIEW_TIMEOUT_MS. */
	"check-idle-efforts.js": 3 * 60 * 1000,
	/* Above the check's own worst case. */
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
 * A core checker's `--json` run, waited for.
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
 * A checker started now and left running. Its bound starts at `settle`, not at the start: the reads between
 * block the event loop, so a timer started with the child would fire on a
 * checker that finished long since, before its output was read. `stop` kills
 * it, for a caller that throws before settling.
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
 * What failed where execFile reports an error, or undefined where the error
 * is only a non-zero exit: that is the checker's verdict.
 * @param {import("node:child_process").ExecFileException | null} error
 * @param {number} timeout ms, the bound `settle` set
 */
function whyStartFailed(error, timeout) {
	if (!error || typeof error.code === "number") return;
	if (error.name === "AbortError")
		return new Error(`killed at its ${timeout} ms bound`);
	if (error.signal) return new Error(`killed by ${error.signal}`);
	return error;
}

module.exports = { runChecker, startChecker };
