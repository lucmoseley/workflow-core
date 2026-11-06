#!/usr/bin/env node
/*
 * start-orphan-sweep-timer.js — make sure a user timer runs
 * reap-orphan-hooks.js every few minutes, so its sweeps run with no session
 * open (#4342): on 2026-11-04 every session had closed while their vitest
 * workers spun on. session-start-sweeps.sh launches it detached at every
 * session start.
 *
 * A TRANSIENT TIMER, started through systemd-run, so nothing is written to the
 * user's unit directory and no install step is owed. It lasts as long as the
 * user manager; a manager restart drops it until the next session start.
 *
 * ONE TIMER A MACHINE, TIMER_UNIT, whichever checkout or plugin install starts
 * it first, as the sweep reads the whole machine. One already active is left
 * alone while the script it runs still exists; one whose script is gone — a
 * removed worktree, a superseded plugin version — is stopped and replaced.
 *
 * THE SCRIPT IT NAMES is the main checkout's copy where this file sits in a
 * linked worktree, which a prune would delete; else this file's sibling.
 *
 * The timer's run persists its report (lib/persist-mode.js), so the next
 * session start replays it; its working directory is the host root, whose
 * notify store that replay reads.
 *
 * WFC_SYSTEMD_RUN and WFC_SYSTEMCTL name stand-in binaries for a test.
 *
 * Exit codes: 0 where the timer runs or no user manager answers; 1 where a
 * systemd call failed.
 */

const fs = require("node:fs");
const path = require("node:path");
const { hostRoot, sessionTree } = require("./lib/host-root.js");
const { runCommand } = require("./lib/run-command.js");
const { writeFd } = require("./lib/write-fd.js");

const UNIT = "wfc-orphan-sweep";
const TIMER_UNIT = `${UNIT}.timer`;
const SERVICE_UNIT = `${UNIT}.service`;
const SWEEP = "reap-orphan-hooks.js";
/* Untraced: a spinning worker costs up to one core for this long before a
 * sweep finds it, against a sweep's ~0.3 s of CPU each firing. */
const PERIOD = "5min";

const systemdRun = () => process.env.WFC_SYSTEMD_RUN || "systemd-run";
const systemctl = () => process.env.WFC_SYSTEMCTL || "systemctl";

/** The sweep script the timer should run. */
function sweepScript() {
	const own = path.join(__dirname, SWEEP);
	const tree = sessionTree({ cwd: __dirname });
	if (tree === null || !__dirname.startsWith(`${tree}/`)) return own;
	const checkout = path.join(hostRoot(), path.relative(tree, __dirname), SWEEP);
	return fs.existsSync(checkout) ? checkout : own;
}

/**
 * The script path the running timer's service names, or null where none is
 * active or its ExecStart names none.
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
	return (
		new RegExp(`argv\\[\\]=\\S+ (\\S+/${SWEEP.replace(".", "\\.")})`).exec(
			exec,
		)?.[1] ?? ""
	);
}

function main() {
	const running = runningScript();
	if (running && fs.existsSync(running)) {
		writeFd(1, `${TIMER_UNIT} already runs ${running}\n`);
		return 0;
	}
	if (running !== null) {
		runCommand(systemctl(), ["--user", "stop", TIMER_UNIT, SERVICE_UNIT]);
		runCommand(systemctl(), ["--user", "reset-failed", SERVICE_UNIT]);
	}
	const script = sweepScript();
	const root = hostRoot();
	const started = runCommand(systemdRun(), [
		"--user",
		`--unit=${UNIT}`,
		"--description=Kill processes whose Claude session has ended (#4342)",
		`--on-active=${PERIOD}`,
		`--on-unit-inactive=${PERIOD}`,
		"--timer-property=AccuracySec=30s",
		"--setenv=WFC_NOTIFY_PERSIST=1",
		`--setenv=PATH=${process.env.PATH ?? "/usr/bin:/bin"}`,
		`--working-directory=${root}`,
		"--property=Nice=10",
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

process.exitCode = main();
