#!/usr/bin/env node
// #5857

const { parseOrExit } = require("./lib/cli-args.js");
const { scriptPath } = require("./lib/script-path.js");
const { DAY_MS, readRows, recordPath } = require("./lib/stale-run-record.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = `usage: node ${scriptPath("stale-run-age.js")} <days>`;

function main() {
	const { positionals } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: {},
		min: 1,
	});
	const days = Number(positionals[0]);
	if (!Number.isInteger(days) || days < 1) {
		writeFd(2, `${USAGE}\n`);
		process.exitCode = 2;
		return;
	}
	const first = readRows(recordPath())?.[0];
	const age = first
		? Math.floor((Date.now() - Date.parse(first.date)) / DAY_MS)
		: 0;
	writeFd(
		1,
		`${age} of ${days} days${first ? ` since the stale-ticket run's first row, ${first.date}` : ": no stale-ticket run is recorded yet"}\n`,
	);
}

if (require.main === module) main();
