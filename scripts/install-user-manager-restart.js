#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { parseOrCode } = require("./lib/cli-args.js");
const { runCommand } = require("./lib/run-command.js");
const { scriptPath } = require("./lib/script-path.js");
const { systemctl } = require("./lib/systemd-bins.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = `usage: sudo "$(command -v node)" ${scriptPath("install-user-manager-restart.js")}`;

const RESTART = "Restart=on-failure";
const MEMWATCH_OOM_SCORE = "OOMScoreAdjust=-500";
// #3963 guess
const START_WINDOW = "10min";

const DROP_IN = `# Written by scripts/install-user-manager-restart.js.
[Unit]
StartLimitIntervalSec=${START_WINDOW}
StartLimitBurst=5

[Service]
${RESTART}
RestartSec=5
${MEMWATCH_OOM_SCORE}
`;

const MANAGER_CONF = `# Written by scripts/install-user-manager-restart.js.
[Manager]
DefaultOOMScoreAdjust=200
`;

const LOADED_VALUES = [
	RESTART,
	MEMWATCH_OOM_SCORE,
	`StartLimitIntervalUSec=${START_WINDOW}`,
];

/**
 * @param {string} root
 * @param {string} rel
 * @param {string} text
 */
function writeRootFile(root, rel, text) {
	const file = path.join(root, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text, { mode: 0o644 });
	return file;
}

/**
 * @param {string} root
 * @param {string} uid
 */
function install(root, uid) {
	const unit = `user@${uid}.service`;
	const files = [
		writeRootFile(root, `etc/systemd/system/${unit}.d/restart.conf`, DROP_IN),
		writeRootFile(root, "etc/systemd/user.conf.d/oom.conf", MANAGER_CONF),
	];
	const reload = runCommand(systemctl(), ["daemon-reload"]);
	const read = runCommand(systemctl(), [
		"show",
		unit,
		"--property=Restart,OOMScoreAdjust,StartLimitIntervalUSec",
	]);
	writeFd(1, `${files.join("\n")}\n${read.out}\n`);
	const lines = read.out.split("\n");
	const errors = [
		...[reload, read].flatMap((r) => r.error ?? []),
		...LOADED_VALUES.filter((want) => !lines.includes(want)).map(
			(want) => `read-back lacks ${want}`,
		),
	];
	for (const error of errors) writeFd(2, `${error}\n`);
	if (errors.length === 0) return 0;
	writeFd(2, `re-run: ${USAGE.replace("usage: ", "")}\n`);
	return 1;
}

/** @param {string} root */
function installForSudoUser(root) {
	const uid = process.env.SUDO_UID ?? "";
	if (!/^[1-9]\d*$/.test(uid)) {
		writeFd(2, `SUDO_UID is "${uid}", not a user to install for\n${USAGE}\n`);
		return 2;
	}
	try {
		return install(root, uid);
	} catch (err) {
		writeFd(2, `${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
}

function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, {
		usage: USAGE,
		flags: { "--root": "value" },
	});
	if (typeof parsed === "number") {
		process.exitCode = parsed;
		return;
	}
	const root = parsed.flags["--root"];
	process.exitCode = installForSudoUser(typeof root === "string" ? root : "/");
}

module.exports = { main };

if (require.main === module) main();
