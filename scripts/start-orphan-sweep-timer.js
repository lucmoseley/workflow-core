#!/usr/bin/env node
/*
 * start-orphan-sweep-timer.js — make sure a user timer runs
 * reap-orphan-hooks.js every few minutes, so its sweeps run with no session
 * open (#4342). session-start-sweeps.sh launches it detached at every
 * session start.
 *
 * A TRANSIENT TIMER, started through systemd-run, so nothing is written to the
 * user's unit directory and no install step is owed. It lasts as long as the
 * user manager; a manager restart drops it until the next session start.
 *
 * ONE TIMER A MACHINE, TIMER_UNIT, whichever checkout or plugin install starts
 * it first, as the sweep reads the whole machine. One already active is left
 * alone while the script it runs exists and is no older than the one this
 * start would name; one whose script is gone — a removed worktree — or older
 * — a superseded plugin version — is stopped and replaced. Older by mtime,
 * so two installs converge on the newer rather than taking turns.
 *
 * THE SCRIPT IT NAMES is the main checkout's copy where this file sits in a
 * linked worktree, which a prune would delete; else this file's sibling.
 *
 * Its working directory is the host root, so the run logs where a session
 * start in the main checkout reads.
 *
 * WFC_SYSTEMD_RUN and WFC_SYSTEMCTL name stand-in binaries for a test.
 *
 * Joins no §N3 family: a launcher, not a checker or a guard.
 *
 * Exit codes: 0 where the timer runs or no user manager answers; 1 where a
 * systemd call failed.
 */

const fs = require("node:fs");
const path = require("node:path");
const { hostRoot, sessionTree } = require("./lib/host-root.js");
const { runCommand } = require("./lib/run-command.js");
const { systemctl, systemdRun } = require("./lib/systemd-bins.js");
const { writeFd } = require("./lib/write-fd.js");

const UNIT = "wfc-orphan-sweep";
const TIMER_UNIT = `${UNIT}.timer`;
const SERVICE_UNIT = `${UNIT}.service`;
const SWEEP = "reap-orphan-hooks.js";
/* Untraced: a spinning worker costs up to one core for this long before a
 * sweep finds it, against a sweep's ~0.3 s of CPU each firing. */
const PERIOD = "5min";
/* systemd's default of 1 min would let a firing slip a fifth of PERIOD; 30 s
 * is a guess, refill-loop-watch.timer's figure. */
const ACCURACY = "30s";
/* A guess: below the sessions' default 0, so a sweep yields to their work. */
const NICE = 10;

/** The sweep script the timer should run. */
function sweepScript() {
	const own = path.join(__dirname, SWEEP);
	const tree = sessionTree({ cwd: __dirname });
	if (tree === null || !__dirname.startsWith(`${tree}/`)) return own;
	const checkout = path.join(hostRoot(), path.relative(tree, __dirname), SWEEP);
	return fs.existsSync(checkout) ? checkout : own;
}

/**
 * The sweep script an ExecStart value names, or "" where it names none.
 * @param {string} exec `systemctl show -p ExecStart --value`'s text
 */
const scriptInExecStart = (exec) =>
	new RegExp(`argv\\[\\]=\\S+ (\\S+/${SWEEP.replace(".", "\\.")})`).exec(
		exec,
	)?.[1] ?? "";

/**
 * The script path the running timer's service names: null where no timer is
 * active, and "" where its ExecStart names no sweep script, which main reads
 * as gone and replaces.
 */
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
	/* A manager that will not answer: no timer to make, and the session-start
	 * run still sweeps. */
	if (/Failed to connect|No such file or directory|ENOENT/.test(started.error))
		return 0;
	/* A concurrent session start made it first. */
	if (/already (?:exists|loaded)/i.test(started.error)) return 0;
	writeFd(2, `${TIMER_UNIT} not started: ${started.error}\n`);
	return 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { scriptInExecStart };
