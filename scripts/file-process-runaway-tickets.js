#!/usr/bin/env node
/*
 * file-process-runaway-tickets.js — file one `takes:triage` ticket for each
 * group memwatch fired on in a process runaway (#3807): an episode, read from the line
 * ~/memwatch.sh appends (lib/process-runaways.js). Once per episode, through
 * lib/incident-tickets.js, and at the first read rather than once it is over: a
 * firing means a process count held for 10 minutes, so it may be running now.
 *
 *   node scripts/file-process-runaway-tickets.js [--dry-run]
 *
 * Reads back LOOKBACK_MS, so a refill loop down for under that files its missed
 * episodes when it returns.
 *
 * Joins no §N3 family: a failed filing exits 1 so the refill loop logs it, as
 * file-memory-kill-tickets.js does.
 *
 * Prints nothing where there is nothing to file. Exit codes: 0 on a pass, an
 * unreadable log included (said on stderr); 1 where a filing or the tracker read
 * failed; 2 on a command line it refuses.
 */

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
