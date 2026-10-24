#!/usr/bin/env node
/*
 * measure-bash-write-firing/measure-claimable-share.js — the false-warn rate
 * again, over the firings that could ever DELIVER a line (mantahostels#2854).
 *
 *   node <this file> <all-fires.jsonl> <marginal-fires.jsonl>
 *
 * A candidate under `.claude/tmp/` is scratch — gitignored, swept at 24 hours,
 * and no session ever claims one — so a firing whose only candidates sit there
 * costs nothing however the arm reads it. Dropping those is what separates
 * mantahostels#2854's two denominators: the whole corpus, and the marginal firings the arm
 * adds over the nine routes alone.
 */
const fs = require("node:fs");
const {
	claimable,
	parseRows,
	quotedTokens,
	writesSomething,
} = require("./lib.js");

const [, , allPath, marginalPath] = process.argv;
if (!allPath || !marginalPath) {
	console.error(
		"usage: measure-claimable-share.js <all-fires.jsonl> <marginal-fires.jsonl>",
	);
	process.exit(2);
}

/** @type {Array<[string, string]>} */
const corpora = [
	["ALL corpus firings ", allPath],
	["MARGINAL arm-only  ", marginalPath],
];
for (const [name, f] of corpora) {
	const { rows, unparsed } = parseRows(fs.readFileSync(f, "utf8"));
	const withClaimable = rows.filter((r) => quotedTokens(r.c).some(claimable));
	const readOnly = withClaimable.filter((r) => !writesSomething(r.c));
	console.log(
		name,
		JSON.stringify({
			firings: rows.length,
			unparsedLines: unparsed,
			withClaimableCandidate: withClaimable.length,
			scratchOnly: rows.length - withClaimable.length,
			readOnlyOfClaimable: readOnly.length,
			falseWarnRate: +(
				readOnly.length / Math.max(1, withClaimable.length)
			).toFixed(3),
		}),
	);
}
