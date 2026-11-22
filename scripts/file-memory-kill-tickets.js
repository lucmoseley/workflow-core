#!/usr/bin/env node

const path = require("node:path");
const { scriptPath } = require("./lib/script-path.js");
const { parseOrExit } = require("./lib/cli-args.js");
const kills = require("./lib/earlyoom-kills.js");
const { hostRoot } = require("./lib/host-root.js");
const { fileIncidents, LOOKBACK_MS } = require("./lib/incident-tickets.js");
const { readTripwire, rearmCommands } = require("./lib/peak-tripwire.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = `usage: node ${scriptPath("file-memory-kill-tickets.js")} [--dry-run]`;
const STANDALONE =
	"a memory kill incident has no originating ticket, so one is filed per incident (#3094)";

function main() {
	const { flags } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: { "--dry-run": "boolean" },
	});
	const root = hostRoot();
	const now = Date.now();
	const { incidents, why } = kills.readIncidents(now - LOOKBACK_MS);
	if (why !== null) {
		writeFd(2, `earlyoom's journal unread, nothing filed: ${why}\n`);
		return 0;
	}
	const tripwire = {
		trip: readTripwire().tripwire.trip,
		rearm: rearmCommands(),
	};
	return fileIncidents({
		root,
		script: path.basename(__filename),
		marker: "memory-kill-tickets",
		what: "memory kill tickets",
		standalone: STANDALONE,
		incidents: incidents.filter((i) => kills.isOver(i, now)),
		titleOf: kills.incidentTitle,
		bodyOf: (i) => kills.buildIncidentBody(i, tripwire),
		readTickets: kills.readIncidentTickets,
		dryRun: flags["--dry-run"] === true,
	});
}

if (require.main === module) process.exitCode = main();
