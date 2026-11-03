/*
 * grouped-child-supervisor.js — runs one `runGrouped` for execGroupedSync, whose
 * blocked caller can run no timer or signal. Reads {file, args, opts} as JSON on
 * stdin and prints the run's result as JSON on stdout (#3923).
 *
 * A fatal signal here exits instead, since node runs no `exit` handler on one
 * and grouped-child.js's is what kills the group.
 */

const { readFdAll } = require("./read-fd.js");
const { runGrouped } = require("./grouped-child.js");
const { writeFd } = require("./write-fd.js");

for (const signal of /** @type {const} */ (["SIGTERM", "SIGINT", "SIGHUP"]))
	process.on(signal, () => process.exit(1));

const { file, args, opts } = JSON.parse(readFdAll(0).toString("utf8"));
runGrouped(file, args, opts).then(
	(run) => {
		writeFd(1, JSON.stringify(run));
		process.exit(0);
	},
	(e) => {
		writeFd(2, `${e.message}\n`);
		process.exit(1);
	},
);
