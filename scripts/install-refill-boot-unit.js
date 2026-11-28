#!/usr/bin/env node
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
const { loginctl, systemctl } = require("./lib/systemd-bins.js");
const {
	buildEnvironmentLine,
	enableUserUnits,
	unquotableFault,
	writeUserUnits,
} = require("./lib/systemd-user-units.js");
const { writeFd } = require("./lib/write-fd.js");

const UNIT = "refill-loop-boot.service";
const WATCH_SERVICE = "refill-loop-watch.service";
const WATCH_TIMER = "refill-loop-watch.timer";
const USAGE = `usage: node ${scriptPath("install-refill-boot-unit.js")}`;

/**
 * @param {string} template
 * @param {string} shell
 * @param {string} script
 * @param {string} log
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
	const fault = unquotableFault([shell, boot.program, files.log]);
	if (fault !== null) {
		writeFd(2, `${fault}\n`);
		return 2;
	}
	const readTemplate = (/** @type {string} */ unit) =>
		fs.readFileSync(path.join(__dirname, `${unit}.template`), "utf8");
	const unitText = (/** @type {string} */ unit) =>
		buildUnitText(readTemplate(unit), shell, boot.program, files.log);
	const dir = writeUserUnits({
		[UNIT]: unitText(UNIT),
		[WATCH_SERVICE]: unitText(WATCH_SERVICE),
		[WATCH_TIMER]: readTemplate(WATCH_TIMER),
	});
	const file = path.join(dir, UNIT);

	const user = os.userInfo().username;
	const enables = enableUserUnits([
		{ unit: UNIT, now: false },
		{ unit: WATCH_TIMER, now: true },
	]);
	const linger = runCommand(loginctl(), ["enable-linger", user]);
	const enabled = runCommand(systemctl(), ["--user", "is-enabled", UNIT]);
	const watchEnabled = runCommand(systemctl(), [
		"--user",
		"is-enabled",
		WATCH_TIMER,
	]);
	const lingerRead = runCommand(loginctl(), [
		"show-user",
		user,
		"--property=Linger",
	]);
	writeFd(
		1,
		`${file}\nis-enabled: ${enabled.out}\n${WATCH_TIMER} is-enabled: ${watchEnabled.out}\n${lingerRead.out}\n`,
	);
	const errors = [
		...enables,
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
