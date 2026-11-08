#!/usr/bin/env node
/*
 * refill-review-run.js — the refill loop's morning review child, run detached
 * so the tick that starts it goes on launching (workflow-core#3765): it runs the review
 * script lib/refill-loop.js's reviewStep picked, under REVIEW_TIMEOUT_MS,
 * and writes the run and its verdict to the loop's review result file
 * (lib/refill-files.js), which the next tick reads, logs and removes.
 *
 *   node scripts/refill-review-run.js '<reviewStep start, as JSON>'
 *
 * One at a time per machine: it holds the review pidfile while it runs, and
 * a second exits at once. The result is written before the pidfile goes.
 *
 * Joins no §N3 family: it reports through the result file, not stdout or an
 * exit code.
 *
 * Caller: lib/refill-tick.js, in the review checkout with its environment.
 */

const path = require("node:path");
const { spawnChild } = require("./lib/child-spawn.js");
const { parseOrExit } = require("./lib/cli-args.js");
const { pidLock } = require("./lib/pid-lock.js");
const { loopFiles, REVIEW_RUNNER } = require("./lib/refill-files.js");
const { writeJson } = require("./lib/refill-json.js");

const USAGE =
	"usage: node scripts/refill-review-run.js '<reviewStep start, as JSON>'";

/* Untraced: some twice a full run's measured time (workflow-core#3765). A run it kills
 * resumes from its kept reads (lib/review-reads.js). */
const REVIEW_TIMEOUT_MS = 30 * 60 * 1000;

function main() {
	const { positionals } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		min: 1,
	});
	const [start] = positionals;
	if (start === undefined)
		throw new Error("parseOrExit passed no reviewStep start despite min: 1");
	/** @type {import("./lib/refill-loop.js").ReviewStart} */
	const run = JSON.parse(start);
	const files = loopFiles();
	const lock = pidLock(files.reviewPid, REVIEW_RUNNER);
	if (!lock.acquire()) return;
	try {
		const { status, failed, out } = spawnChild(
			process.execPath,
			[path.join(__dirname, path.basename(run.script))],
			{ stdio: ["ignore", "pipe", "pipe"], timeout: REVIEW_TIMEOUT_MS },
		);
		writeJson(files.review, { ...run, status, failed, out });
	} finally {
		lock.release();
	}
}

if (require.main === module) main();
