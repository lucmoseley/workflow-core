#!/usr/bin/env node

const path = require("node:path");
const { scriptPath } = require("./lib/script-path.js");
const { spawnChild } = require("./lib/child-spawn.js");
const { parseOrExit } = require("./lib/cli-args.js");
const { pidLock } = require("./lib/pid-lock.js");
const { loopFiles, REVIEW_RUNNER } = require("./lib/refill-files.js");
const { writeJson } = require("./lib/refill-json.js");

const USAGE = `usage: node ${scriptPath("refill-review-run.js")} '<reviewStep start, as JSON>'`;

// #3765 guess
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
