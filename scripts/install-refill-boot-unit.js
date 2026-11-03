#!/usr/bin/env node
/*
 * install-refill-boot-unit.js — installs and enables this host's systemd user
 * unit that runs `refill-loop.js boot-resume` at each manager start (#3878), from
 * refill-loop-boot.service.template, turns linger on, and reads both back.
 * Enabled, not started: the unit first runs at the manager's next start. Also
 * the timer that resumes a dead loop (`refill-loop.js watch`, #4139), enabled
 * and started, as a loop can die before the manager next starts.
 *
 * In a checkout the unit names the boot link (lib/refill-code.js), made here
 * where no loop has made it. A plugin install names its own refill-loop.js, so
 * re-runs this after a release bump moves it. Re-running replaces the unit.
 *
 * Joins no §N3 family: an install command, not a checker or a guard.
 *
 * Exit codes: 0; 1 where no code can be pinned, or the read-back or a systemd
 * call fails; 2 on a command line, or a path the unit could not quote.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { claudeBin } = require("./lib/claude-bin.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { configDir } = require("./lib/config-dir.js");
const { bootProgram } = require("./lib/refill-code.js");
const { loopFiles } = require("./lib/refill-files.js");
const { runCommand } = require("./lib/run-command.js");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");

const UNIT = "refill-loop-boot.service";
const WATCH_SERVICE = "refill-loop-watch.service";
const WATCH_TIMER = "refill-loop-watch.timer";
const USAGE = `usage: node ${scriptPath("install-refill-boot-unit.js")}`;

/* Refused rather than shell-quoted: these sit inside a command string that
 * systemd unquotes first. */
const PLAIN_PATH = /^[\w./@+-]+$/;

/**
 * An Environment= line, its value escaped for systemd's own expansions.
 * @param {string} name
 * @param {string} value
 */
function buildEnvironmentLine(name, value) {
	const escaped = value
		.replace(/[\\"]/g, "\\$&")
		.replace(/%/g, "%%")
		.replace(/\$/g, "$$$$");
	return `Environment="${name}=${escaped}"`;
}

/**
 * The unit's text: the installer's own PATH, which holds what systemd's lacks; its seat; and its session-listing wrapper,
 * which a shell alias sets rather than the profile.
 * @param {string} template
 * @param {string} shell
 * @param {string} script
 * @param {string} log the loop's log
 */
function buildUnitText(template, shell, script, log) {
	const environment = [
		buildEnvironmentLine("PATH", process.env.PATH ?? ""),
		buildEnvironmentLine("CLAUDE_CONFIG_DIR", configDir()),
		buildEnvironmentLine("WFC_CLAUDE_BIN", claudeBin()),
	].join("\n");
	return template
		.replace("@ENVIRONMENT@", () => environment)
		.replace("@SHELL@", () => shell)
		.replace("@SCRIPT@", () => script)
		.replaceAll("@LOG@", () => log);
}

function install() {
	const shell = process.env.SHELL || "/bin/bash";
	const files = loopFiles();
	const boot = bootProgram({ scriptsDir: __dirname, codeDir: files.code });
	if ("error" in boot) {
		writeFd(2, `no code for the unit to start: ${boot.error}\n`);
		return 1;
	}
	if (boot.fetchError)
		writeFd(
			2,
			`fetch failed, pinning the last fetched tip: ${boot.fetchError}\n`,
		);
	for (const word of [shell, boot.program, files.log])
		if (!PLAIN_PATH.test(word)) {
			writeFd(2, `the unit cannot quote this path: ${word}\n`);
			return 2;
		}
	const readTemplate = (/** @type {string} */ unit) =>
		fs.readFileSync(path.join(__dirname, `${unit}.template`), "utf8");
	const dir = path.join(
		process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
		"systemd",
		"user",
	);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, UNIT);
	fs.writeFileSync(
		file,
		buildUnitText(readTemplate(UNIT), shell, boot.program, files.log),
	);
	fs.writeFileSync(
		path.join(dir, WATCH_SERVICE),
		buildUnitText(readTemplate(WATCH_SERVICE), shell, boot.program, files.log),
	);
	fs.writeFileSync(path.join(dir, WATCH_TIMER), readTemplate(WATCH_TIMER));

	const user = os.userInfo().username;
	const reload = runCommand("systemctl", ["--user", "daemon-reload"]);
	const enable = reload.error
		? reload
		: runCommand("systemctl", ["--user", "enable", UNIT]);
	const watch = reload.error
		? reload
		: runCommand("systemctl", ["--user", "enable", "--now", WATCH_TIMER]);
	const linger = runCommand("loginctl", ["enable-linger", user]);
	const enabled = runCommand("systemctl", ["--user", "is-enabled", UNIT]);
	const watchEnabled = runCommand("systemctl", [
		"--user",
		"is-enabled",
		WATCH_TIMER,
	]);
	const lingerRead = runCommand("loginctl", [
		"show-user",
		user,
		"--property=Linger",
	]);
	writeFd(
		1,
		`${file}\nis-enabled: ${enabled.out}\n${WATCH_TIMER} is-enabled: ${watchEnabled.out}\n${lingerRead.out}\n`,
	);
	const errors = [
		enable,
		watch,
		linger,
		enabled,
		watchEnabled,
		lingerRead,
	].flatMap((r) => r.error ?? []);
	for (const error of errors) writeFd(2, `${error}\n`);
	return errors.length === 0 &&
		enabled.out === "enabled" &&
		watchEnabled.out === "enabled" &&
		lingerRead.out === "Linger=yes"
		? 0
		: 1;
}

function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, { usage: USAGE, flags: {} });
	process.exitCode = typeof parsed === "number" ? parsed : install();
}

module.exports = { main };

if (require.main === module) main();
