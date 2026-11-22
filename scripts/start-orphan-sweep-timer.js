#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { hostRoot, sessionTree } = require("./lib/host-root.js");
const { runCommand } = require("./lib/run-command.js");
const { systemctl, systemdRun } = require("./lib/systemd-bins.js");
const { writeFd } = require("./lib/write-fd.js");
const { relativeUnder } = require("./lib/is-under.js");
const { escapeRe } = require("./lib/regex-group.js");

const UNIT = "wfc-orphan-sweep";
const TIMER_UNIT = `${UNIT}.timer`;
const SERVICE_UNIT = `${UNIT}.service`;
const SWEEP = "reap-orphan-hooks.js";
// #4342 guess
const PERIOD = "5min";
// #4342 guess
const ACCURACY = "30s";
// #4342 guess
const NICE = 10;

function sweepScript() {
	const own = path.join(__dirname, SWEEP);
	const tree = sessionTree({ cwd: __dirname });
	const rel = tree === null ? null : relativeUnder(tree, __dirname);
	if (!rel) return own;
	const checkout = path.join(hostRoot(), rel, SWEEP);
	return fs.existsSync(checkout) ? checkout : own;
}

/** @param {string} exec */
const scriptInExecStart = (exec) =>
	new RegExp(`argv\\[\\]=\\S+ (\\S+/${escapeRe(SWEEP)})`).exec(exec)?.[1] ?? "";

function runningScript() {
	const active = runCommand(systemctl(), ["--user", "is-active", TIMER_UNIT]);
	if (active.out !== "active") return null;
	const exec = runCommand(systemctl(), [
		"--user",
		"show",
		SERVICE_UNIT,
		"-p",
		"ExecStart",
		"--value",
	]).out;
	return scriptInExecStart(exec);
}

/** @param {string} file @returns {number|null} */
function mtime(file) {
	try {
		return fs.statSync(file).mtimeMs;
	} catch {
		return null;
	}
}

function main() {
	const running = runningScript();
	const script = sweepScript();
	const ran = running ? mtime(running) : null;
	const ours = mtime(script) ?? 0;
	if (running && ran !== null && (running === script || ran >= ours)) {
		writeFd(1, `${TIMER_UNIT} already runs ${running}\n`);
		return 0;
	}
	if (running !== null) {
		runCommand(systemctl(), ["--user", "stop", TIMER_UNIT, SERVICE_UNIT]);
		runCommand(systemctl(), ["--user", "reset-failed", SERVICE_UNIT]);
	}
	const root = hostRoot();
	const started = runCommand(systemdRun(), [
		"--user",
		`--unit=${UNIT}`,
		"--description=Kill processes whose Claude session has ended (#4342)",
		`--on-active=${PERIOD}`,
		`--on-unit-inactive=${PERIOD}`,
		`--timer-property=AccuracySec=${ACCURACY}`,
		`--setenv=PATH=${process.env.PATH ?? "/usr/bin:/bin"}`,
		`--working-directory=${root}`,
		`--property=Nice=${NICE}`,
		"--",
		process.execPath,
		script,
		"--notify",
	]);
	if (started.error === null) {
		writeFd(1, `${TIMER_UNIT} started: ${script} every ${PERIOD}\n`);
		return 0;
	}
	if (/Failed to connect|No such file or directory|ENOENT/.test(started.error))
		return 0;
	if (/already (?:exists|loaded)/i.test(started.error)) return 0;
	writeFd(2, `${TIMER_UNIT} not started: ${started.error}\n`);
	return 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { scriptInExecStart };
