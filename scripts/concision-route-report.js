#!/usr/bin/env node
/*
 * concision-route-report.js — prints findings-per-concision-pass split by the
 * route the pass took, from the `.concision-pass-<session-id>` receipts lying
 * in the repo root.
 *
 *   npm run report:concision-routes
 *   node scripts/concision-route-report.js [--dir <path>]
 *
 * Exits 0 on any report, an unreadable directory included; 2 on an unknown
 * flag or a bare `--dir` (workflow-core#2218).
 *
 * Built at mantahostels#1099 (the ticket that added `route=` to the receipt) to make its
 * deferred comparison — subagent passes against in-session ones, once ~40 have
 * run — a single command rather than a fresh analysis.
 *
 * IN NO §N3 FAMILY, DELIBERATELY. It gates nothing, so it is no `check-*`; it
 * runs from a prompt rather than a hook, so it is no `guard-*`; it writes no
 * file, so it is no `generate-*`; and it files no issue, so it is no `report-*`
 * despite what it does.
 */

const { collect, report } = require("./lib/concision-receipts.js");
const { hostRoot } = require("./lib/host-root.js");
const { flagValue, parseOrExit } = require("./lib/cli-args.js");

const CLI = {
	usage: "usage: node scripts/concision-route-report.js [--dir <path>]",
	flags: { "--dir": /** @type {const} */ ("value") },
};

/**
 * Where the receipts are. `--dir` is for the tests, which mint a throwaway
 * directory.
 *
 * @param {string[]} argv
 * @returns {string}
 */
function receiptDir(argv) {
	return flagValue(parseOrExit(argv, CLI).flags, "--dir") ?? hostRoot();
}

if (require.main === module) {
	const dir = receiptDir(process.argv.slice(2));
	try {
		console.log(report(collect(dir)));
	} catch (err) {
		// Unreadable directory. Said out loud rather than reported as an
		// empty corpus, which reads as "no passes have run".
		console.error(`Cannot read receipts in ${dir}: ${String(err)}`);
	}
	// No exit code past the argument check: there is no verdict here to fail a
	// build on (workflow-core#2218). Nor a process.exit, which could drop piped output.
}
