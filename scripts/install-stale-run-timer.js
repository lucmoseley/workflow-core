#!/usr/bin/env node
// #5857
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseOrCode } = require("./lib/cli-args.js");
const { configDir } = require("./lib/config-dir.js");
const { hostRoot, sessionTree } = require("./lib/host-root.js");
const { relativeUnder } = require("./lib/is-under.js");
const { runCommand } = require("./lib/run-command.js");
const { scriptPath } = require("./lib/script-path.js");
const { systemctl } = require("./lib/systemd-bins.js");
const { writeFd } = require("./lib/write-fd.js");

const SERVICE = "stale-ticket-run.service";
const TIMER = "stale-ticket-run.timer";
const RUN = "stale-ticket-run.js";
const USAGE = `usage: node ${scriptPath("install-stale-run-timer.js")}`;
// #4342 guess
const NICE = 10;

const PLAIN_PATH = /^[\w./@+-]+$/;

/**
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

function runScript() {
	const own = path.join(__dirname, RUN);
	const tree = sessionTree({ cwd: __dirname });
	const rel = tree === null ? null : relativeUnder(tree, __dirname);
	if (!rel) return own;
	const checkout = path.join(hostRoot(), rel, RUN);
	return fs.existsSync(checkout) ? checkout : own;
}

/**
 * @param {string} template
 * @param {{script: string, root: string}} at
 */
function buildServiceText(template, { script, root }) {
	const environment = [
		buildEnvironmentLine("PATH", process.env.PATH ?? ""),
		buildEnvironmentLine("CLAUDE_CONFIG_DIR", configDir()),
	].join("\n");
	return template
		.replace("@ENVIRONMENT@", () => environment)
		.replace("@NICE@", String(NICE))
		.replace("@ROOT@", () => root)
		.replace("@SCRIPT@", () => script);
}

function install() {
	const script = runScript();
	const root = path.dirname(path.dirname(script));
	for (const word of [script, root])
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
	fs.writeFileSync(
		path.join(dir, SERVICE),
		buildServiceText(readTemplate(SERVICE), { script, root }),
	);
	fs.writeFileSync(path.join(dir, TIMER), readTemplate(TIMER));

	const reload = runCommand(systemctl(), ["--user", "daemon-reload"]);
	const enable = reload.error
		? reload
		: runCommand(systemctl(), ["--user", "enable", "--now", TIMER]);
	const enabled = runCommand(systemctl(), ["--user", "is-enabled", TIMER]);
	writeFd(
		1,
		`${path.join(dir, TIMER)}\n${TIMER} is-enabled: ${enabled.out}\nruns: ${script}\n`,
	);
	const errors = [enable, enabled].flatMap((r) => r.error ?? []);
	for (const error of errors) writeFd(2, `${error}\n`);
	return errors.length === 0 && enabled.out === "enabled" ? 0 : 1;
}

function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, { usage: USAGE, flags: {} });
	process.exitCode = typeof parsed === "number" ? parsed : install();
}

module.exports = { main };

if (require.main === module) main();
