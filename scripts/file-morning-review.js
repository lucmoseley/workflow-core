#!/usr/bin/env node
/*
 * file-morning-review.js — file the day's morning review issue (#2011, spec
 * #1995 §The morning review issue). Its core, lib/morning-review-filing.js,
 * does the once-a-day check, the reads, the rendering, the filing and the
 * reversals' answering, and its header says what the review holds and its
 * exit. This shell wires the production adapters, lib/checker-run.js's among
 * them.
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
 * a filing from a failure.
 */

const { answerReversals } = require("./answer-review-reversals.js");
const { parseOrExit } = require("./lib/cli-args.js");
const { gh } = require("./lib/gh.js");
const { hostRoot } = require("./lib/host-root.js");
const { scriptPath } = require("./lib/script-path.js");
const { fileThrough } = require("./lib/file-through.js");
const { writeFd } = require("./lib/write-fd.js");
const {
	buildCrashLine,
	fileMorningReview,
} = require("./lib/morning-review-filing.js");
const { scriptIo } = require("./lib/tracker-ops.js");
const { runChecker, startChecker } = require("./lib/checker-run.js");

const USAGE = `usage: node ${scriptPath("file-morning-review.js")} [--dry-run]`;

const io = scriptIo("file-morning-review");

/** @type {import("./lib/morning-review-filing.js").Ports} */
const PORTS = {
	now: () => new Date(),
	out: (text) => io.out(text),
	err: (text) => writeFd(2, text),
	gh,
	file: (argv, body) => fileThrough(argv, body, hostRoot()),
	runChecker,
	startChecker,
	answer: answerReversals,
};

/** @param {string[]} argv */
async function main(argv = process.argv.slice(2)) {
	const { flags } = parseOrExit(argv, {
		usage: USAGE,
		flags: { "--dry-run": "boolean" },
	});
	const tracker = io.trackerOrFail();
	const dryRun = flags["--dry-run"] === true;
	process.exitCode = await fileMorningReview({ tracker, dryRun, ports: PORTS });
}

module.exports = { main };

if (require.main === module)
	main().catch((e) => {
		writeFd(2, buildCrashLine(e));
		process.exitCode = 1;
	});
