#!/usr/bin/env node
const fs = require("node:fs");
const { writeFd } = require("../lib/write-fd.js");
const { parseRows, writesSomething } = require("./lib.js");

const [, , firesPath, samplePath] = process.argv;
if (!firesPath || !samplePath) {
	writeFd(2, "usage: classify-false-warns.js <fires.jsonl> <sample60.txt>\n");
	process.exit(2);
}

const { rows, unparsed } = parseRows(fs.readFileSync(firesPath, "utf8"));
const readOnly = rows.filter((r) => !writesSomething(r.c));
writeFd(
	1,
	`${JSON.stringify(
		{
			firings: rows.length,
			unparsedLines: unparsed,
			writesSomething: rows.length - readOnly.length,
			readOnly: readOnly.length,
			falseWarnRate: +(readOnly.length / Math.max(1, rows.length)).toFixed(3),
		},
		null,
		2,
	)}\n`,
);

let seed = 2854;
const rnd = () => {
	seed = (seed * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
	return seed / 0x7f_ff_ff_ff;
};

// measured on 60 hand-read commands, lucmoseley/mantahostels#2854
const EXCERPT = 400;
const pick = [];
const seen = new Set();
while (pick.length < 60 && seen.size < rows.length) {
	const i = Math.floor(rnd() * rows.length);
	if (seen.has(i)) continue;
	seen.add(i);
	const row = rows[i];
	if (row === undefined)
		throw new Error(`draw ${i} fell outside the ${rows.length} rows`);
	pick.push({
		i,
		verdict: writesSomething(row.c) ? "WRITE" : "READ",
		c: row.c.slice(0, EXCERPT),
	});
}
fs.writeFileSync(
	samplePath,
	pick.map((p) => `--- ${p.i} ${p.verdict}\n${p.c}`).join("\n"),
);
