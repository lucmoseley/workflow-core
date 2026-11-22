#!/usr/bin/env node

const path = require("node:path");
const { scriptPath } = require("./lib/script-path.js");
const { now } = require("./lib/check.js");
const { parseOrExit } = require("./lib/cli-args.js");
const { hostRoot } = require("./lib/host-root.js");
const { fileIncidents, LOOKBACK_MS } = require("./lib/incident-tickets.js");
const runaways = require("./lib/process-runaways.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = `usage: node ${scriptPath("file-process-runaway-tickets.js")} [--dry-run]`;
const STANDALONE =
	"a process runaway has no originating ticket, so one is filed per episode (#3807)";

function main() {
	const { flags } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: { "--dry-run": "boolean" },
	});
	const { episodes, why } = runaways.readEpisodes(now() - LOOKBACK_MS);
	if (why !== null) {
		writeFd(2, `memwatch's runaway log unread, nothing filed: ${why}\n`);
		return 0;
	}
	return fileIncidents({
		root: hostRoot(),
		script: path.basename(__filename),
		marker: "process-runaway-tickets",
		what: "process runaway tickets",
		standalone: STANDALONE,
		incidents: episodes,
		titleOf: runaways.buildEpisodeTitle,
		bodyOf: runaways.buildEpisodeBody,
		readTickets: runaways.readEpisodeTickets,
		dryRun: flags["--dry-run"] === true,
	});
}

if (require.main === module) process.exitCode = main();
