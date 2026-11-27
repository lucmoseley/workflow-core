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
const { gh } = require("./lib/gh.js");
const { setLaunchHold } = require("./lib/launch-hold.js");
const { DIAG } = require("./lib/pfn-scan-host.js");
const { runCommand } = require("./lib/run-command.js");
const { scriptPath } = require("./lib/script-path.js");
const { sleepSync } = require("./lib/sleep-sync.js");
const { requireKey } = require("./lib/workflow-core-config.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = `usage: node ${scriptPath("combining-trial.js")} night | morning`;
const SCHTASKS = "/mnt/c/Windows/System32/schtasks.exe";

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
		try {
			return fs.readFileSync(path.join(DIAG, name), "utf8");
		} catch {
			return "";
		}
	},
	startTask: (name) =>
		runCommand(process.env.WFC_SCHTASKS || SCHTASKS, ["/Run", "/TN", name])
			.error,
	sleep: sleepSync,
	hold: () => setLaunchHold(HOLDER, "hold"),
	release: () => setLaunchHold(HOLDER, "release"),
	scan: (dump, combining) =>
		attempt(() => {
			const wsl = runCommand("wslpath", ["-u", dump]);
			if (wsl.error !== null) throw new Error(wsl.error);
			const { scanAndReport } = require("./pfn-scan.js");
			scanAndReport(wsl.out, { combining, post: REPORT_ISSUE });
		}),
	post: (body) =>
		attempt(() =>
			gh(
				[
					"issue",
					"comment",
					String(REPORT_ISSUE),
					"--repo",
					requireKey("tracker"),
					"--body-file",
					"-",
				],
				{ input: body },
			),
		),
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
