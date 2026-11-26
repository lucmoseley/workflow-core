#!/usr/bin/env node
const fs = require("node:fs");
const { writeFd } = require("../lib/write-fd.js");
const {
	claimable,
	parseRows,
	quotedTokens,
	writesSomething,
} = require("./lib.js");

const [, , allPath, marginalPath] = process.argv;
if (!allPath || !marginalPath) {
	writeFd(
		2,
		"usage: measure-claimable-share.js <all-fires.jsonl> <marginal-fires.jsonl>\n",
	);
	process.exit(2);
}

/** @type {Array<[string, string]>} */
const corpora = [
	["ALL corpus firings ", allPath],
	["MARGINAL arm-only  ", marginalPath],
];
for (const [name, f] of corpora) {
	const { rows, unparsed, zeroed } = parseRows(fs.readFileSync(f, "utf8"));
	const withClaimable = rows.filter((r) => quotedTokens(r.c).some(claimable));
	const readOnly = withClaimable.filter((r) => !writesSomething(r.c));
	writeFd(
		1,
		`${name} ${JSON.stringify({
			firings: rows.length,
			unparsedLines: unparsed,
			zeroedRecords: zeroed,
			withClaimableCandidate: withClaimable.length,
			scratchOnly: rows.length - withClaimable.length,
			readOnlyOfClaimable: readOnly.length,
			falseWarnRate: +(
				readOnly.length / Math.max(1, withClaimable.length)
			).toFixed(3),
		})}\n`,
	);
}
