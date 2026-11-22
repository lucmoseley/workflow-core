#!/usr/bin/env node
// cli-args-exempt: #4820

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
