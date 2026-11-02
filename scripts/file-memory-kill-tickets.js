#!/usr/bin/env node
/*
 * file-memory-kill-tickets.js — file one `takes:triage` ticket for each
 * earlyoom kill incident that is over (#3094, ruled at #3082): kills no more
 * than 30 min apart, read from earlyoom's journal (lib/earlyoom-kills.js).
 * A kill means admission let memory run out, so each incident has a cause
 * for a session to find.
 *
 *   node scripts/file-memory-kill-tickets.js [--dry-run]
 *
 * Once per incident, through lib/incident-tickets.js.
 *
 * Reads back LOOKBACK_MS, so a refill loop down for under that files its
 * missed incidents when it returns. An incident not yet over waits for a
 * later tick: a kill may still join it.
 *
 * Joins no §N3 family: it files issues as `report-*` does, but a failed
 * filing exits 1 so the refill loop logs it, as file-morning-review.js does.
 *
 * Prints nothing where there is nothing to file. Exit codes: 0 on a pass, an
 * unreadable journal included (said on stderr: earlyoom's log is subject, not
 * apparatus); 1 where a filing or the tracker read failed; 2 on a command line
 * it refuses.
 *
 * Caller: the refill loop, every tick (scripts/refill-loop.js).
 */

const path = require("node:path");
const { parseOrExit } = require("./lib/cli-args.js");
const kills = require("./lib/earlyoom-kills.js");
const { hostRoot } = require("./lib/host-root.js");
const { fileIncidents, LOOKBACK_MS } = require("./lib/incident-tickets.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = "usage: node scripts/file-memory-kill-tickets.js [--dry-run]";
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
	return fileIncidents({
		root,
		script: path.basename(__filename),
		marker: "memory-kill-tickets",
		what: "memory kill tickets",
		standalone: STANDALONE,
		incidents: incidents.filter((i) => kills.isOver(i, now)),
		titleOf: kills.incidentTitle,
		bodyOf: kills.buildIncidentBody,
		readTickets: kills.readIncidentTickets,
		dryRun: flags["--dry-run"] === true,
	});
}

if (require.main === module) process.exitCode = main();
