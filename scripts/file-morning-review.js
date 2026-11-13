#!/usr/bin/env node
/*
 * file-morning-review.js — file the day's morning review issue (#2011, spec
 * #1995 §The morning review issue). Its core, lib/morning-review-filing.js,
 * does the once-a-day check, the reads, the rendering and the filing, and its
 * header says what the review holds. This shell wires the production
 * adapters, writes what the core returns, then answers the reversals.
 *
 *   node scripts/file-morning-review.js [--dry-run]
 *
 * REVERSALS (#3388): after filing, it answers each unanswered `reverse <n>`
 * through scripts/answer-review-reversals.js (#2017), so a hand run while the
 * loop is stopped answers them too. `--dry-run` passes to both.
 *
 * Joins no §N3 family: it files an issue as `report-*` does, but a run whose
 * filing failed on gh or found the filing lock held exits 1, and one
 * file-issue.js refused exits with its code, so the loop that runs it can tell
 * a filing from a failure. The exit code is the worse of the filing's and the
 * answering's.
 */

const { execFile, spawnSync } = require("node:child_process");
const path = require("node:path");
const { answerReversals } = require("./answer-review-reversals.js");
const { parseOrExit } = require("./lib/cli-args.js");
const { gh } = require("./lib/gh.js");
const { hostRoot } = require("./lib/host-root.js");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const { coreRoot, scriptPath } = require("./lib/script-path.js");
const { fileThrough } = require("./lib/file-through.js");
const { writeFd } = require("./lib/write-fd.js");
const { fileMorningReview } = require("./lib/morning-review-filing.js");
const { scriptIo } = require("./lib/tracker-ops.js");

const USAGE = `usage: node ${scriptPath("file-morning-review.js")} [--dry-run]`;

/** Each checker's bound, in ms. */
const CHECKER_TIMEOUT_MS = {
	/* Untraced: the count line runs every enforcing check over the whole tree. */
	"check-primitives.js": 5 * 60 * 1000,
	/* One paged GraphQL read per tracker, run side by side. Measured on 1 Nov
	 * across six trackers: 10-16 s in six runs, 71 s in another. 2.5x that worst
	 * run, the multiplier a guess (#3771), and well inside refill-review-run.js's
	 * REVIEW_TIMEOUT_MS. */
	"check-idle-efforts.js": 3 * 60 * 1000,
	/* Above the check's own worst case, 196 s: wsl.exe's 3 tries at 12 s, two gh reads at 80 s. */
	"check-wsl-currency.js": 4 * 60 * 1000,
};

const io = scriptIo("file-morning-review");

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
 * @returns {import("./lib/morning-review-filing.js").Started}
 */
function startChecker(script) {
	const timeout = boundOf(script);
	const stop = new AbortController();
	/** @type {NodeJS.Timeout | undefined} */
	let bound;
	let ended = false;
	/** @type {Promise<import("./lib/morning-review-filing.js").CheckerRun>} */
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

/** @type {import("./lib/morning-review-filing.js").Ports} */
const PORTS = {
	now: () => new Date(),
	gh,
	file: (argv, body) => fileThrough(argv, body, hostRoot()),
	runChecker,
	startChecker,
};

/** @param {string[]} argv */
async function main(argv = process.argv.slice(2)) {
	const { flags } = parseOrExit(argv, {
		usage: USAGE,
		flags: { "--dry-run": "boolean" },
	});
	const tracker = io.trackerOrFail();
	const dryRun = flags["--dry-run"] === true;
	/* A filing that throws still answers before the throw ends the run. */
	let filed = 1;
	try {
		const r = await fileMorningReview({ tracker, dryRun, ports: PORTS });
		io.out(r.stdout);
		writeFd(2, r.stderr);
		filed = r.code;
	} finally {
		process.exitCode = Math.max(filed, answerReversals(tracker, dryRun));
	}
}

module.exports = { main };

if (require.main === module)
	main().catch((e) => {
		writeFd(
			2,
			`file-morning-review: ${e instanceof Error ? e.stack : String(e)}\n`,
		);
		/* main's finally has already set the answering's code; a failure is no better. */
		process.exitCode = Math.max(1, Number(process.exitCode ?? 0));
	});
