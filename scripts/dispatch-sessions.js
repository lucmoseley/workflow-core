#!/usr/bin/env node
/*
 * dispatch-sessions.js — launch a /pick-next dispatch set, each session on the
 * model its kind calls for, and only as many as allowance remains for. The
 * shell of lib/dispatch-sessions.js, whose header holds the usage, the gates
 * and the exit codes (#5145).
 *
 * cli-args-exempt: the core parses the line, refusing an unknown flag, `--help`
 * included, at exit 2; a strict parser would also refuse a prompt opening with
 * `-`, which launches as a prompt (#4820).
 */

const { dispatch } = require("./lib/dispatch-sessions.js");
const { hostPorts } = require("./lib/dispatch-sessions-host.js");
const { writeFd } = require("./lib/write-fd.js");

dispatch(
	process.argv.slice(2),
	{ ...hostPorts(), write: (fd, text) => writeFd(fd, text) },
	{ env: process.env, cwd: process.cwd() },
).then(
	(r) => process.exit(r.code),
	(e) => {
		writeFd(2, `dispatch-sessions: ${e?.stack ?? e}\n`);
		process.exit(1);
	},
);
