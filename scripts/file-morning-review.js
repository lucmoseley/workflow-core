#!/usr/bin/env node
// #5865

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
