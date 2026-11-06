#!/usr/bin/env node
/*
 * install-user-manager-restart.js — run under sudo, makes the invoking user's
 * systemd manager come back after a kill, without a boot, and has the kernel's
 * OOM killer take every session before it (#3963). Re-running replaces both files.
 *
 * The restart holds from the install. The OOM values take at the manager's next
 * start, so memwatch's own -500 is refused until then (docs/environment.md §4).
 *
 * `--root` prefixes the two paths and drops the need for root, for a test.
 *
 * Joins no §N3 family: an install command, not a checker or a guard.
 *
 * Exit codes: 0; 1 where a write, a systemd call or the read-back fails; 2 on a
 * command line, or a run with no sudo to name the user by.
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseOrCode } = require("./lib/cli-args.js");
const { runCommand } = require("./lib/run-command.js");
const { scriptPath } = require("./lib/script-path.js");
const { systemctl } = require("./lib/systemd-bins.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = `usage: sudo "$(command -v node)" ${scriptPath("install-user-manager-restart.js")}`;

/* on-failure, not memwatch's always: a stop of the manager that exits cleanly, as
 * at shutdown, stays a stop. */
const RESTART = "Restart=on-failure";
/* memwatch.service's own declared value. */
const OOM_SCORE = "OOMScoreAdjust=-500";
/* Five starts in this window is untraced: past it the manager stays down, so a
 * kill loop cannot spin for ever. The stock 10 s never trips at RestartSec=5. */
const START_WINDOW = "10min";

const DROP_IN = `# Written by scripts/install-user-manager-restart.js.
[Unit]
StartLimitIntervalSec=${START_WINDOW}
StartLimitBurst=5

[Service]
${RESTART}
RestartSec=5
${OOM_SCORE}
`;

/* What a manager at the stock 100 gives its units: without this, each unit that
 * declares no value would drop to the manager's value plus 100, and a loop the
 * boot unit starts would pass that shield on to its sessions. */
const MANAGER_CONF = `# Written by scripts/install-user-manager-restart.js.
[Manager]
DefaultOOMScoreAdjust=200
`;

const LOADED_VALUES = [
	RESTART,
	OOM_SCORE,
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
