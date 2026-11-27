#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./lib/caught.js");
const { now } = require("./lib/check.js");
const { parseOrCode } = require("./lib/cli-args.js");
const {
	HOLDER,
	REPORT_ISSUE,
	runMorning,
	runNight,
} = require("./lib/combining-trial.js");
const { setLaunchHold } = require("./lib/launch-hold.js");
const { DIAG } = require("./lib/pfn-scan-host.js");
const { postComment, scanAndReport } = require("./pfn-scan.js");
const { readText } = require("./lib/file-read.js");
const { scriptPath } = require("./lib/script-path.js");
const { sleepSync } = require("./lib/sleep-sync.js");
const { runTask, toWsl } = require("./lib/windows-host.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = `usage: node ${scriptPath("combining-trial.js")} night | morning`;

/** @param {() => void} fn @returns {string | null} */
function attempt(fn) {
	try {
		fn();
		return null;
	} catch (e) {
		return caught(e).message;
	}
}

/** @type {import("./lib/combining-trial.js").Ports} */
const ports = {
	now: () => now(),
	ended: () => fs.existsSync(path.join(DIAG, "ended.txt")),
	readLog: (name) => {
		const r = readText(path.join(DIAG, name));
		if (r.state === "unreadable") throw new Error(`${name}: ${r.message}`);
		return r.state === "read" ? r.data : "";
	},
	startTask: runTask,
	sleep: sleepSync,
	hold: () => setLaunchHold(HOLDER, "hold"),
	release: () => setLaunchHold(HOLDER, "release"),
	scan: (dump, combining) =>
		attempt(() => {
			scanAndReport(toWsl(dump), { combining, post: REPORT_ISSUE });
		}),
	post: (body) => attempt(() => postComment(REPORT_ISSUE, body)),
	say: (line) => writeFd(2, `${new Date(now()).toISOString()} ${line}\n`),
};

/** @param {string[]} [argv] */
function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, {
		usage: USAGE,
		commands: { night: { usage: USAGE }, morning: { usage: USAGE } },
	});
	if (typeof parsed === "number") return parsed;
	try {
		return parsed.command === "night" ? runNight(ports) : runMorning(ports);
	} catch (e) {
		writeFd(2, `combining-trial: ${caught(e).message}\n`);
		return 1;
	}
}

if (require.main === module) process.exitCode = main();

module.exports = { main };
