#!/usr/bin/env node
/*
 * measure-bash-write-firing/classify-false-warns.js — mantahostels#2854's false-warn rate.
 * A firing is a FALSE WARN where the command's inline program writes no file at
 * all: the arm named a tier-1 path the command merely READ.
 *
 *   node <this file> <fires.jsonl> <sample60.txt>
 *
 * `fires.jsonl` comes from measure-firing-rate.js. The second argument is where
 * the hand-check sample is written.
 *
 * LEXICAL, so it is a rate with a hand-checked error bar, not an exact count —
 * lib.js's WRITE_CALL carries what that costs. The hand check IS the 60-command
 * sample this writes: mantahostels#2854's 33% and 46% were reported only after reading it.
 */
const fs = require("node:fs");
const { parseRows, writesSomething } = require("./lib.js");

const [, , firesPath, samplePath] = process.argv;
if (!firesPath || !samplePath) {
	console.error("usage: classify-false-warns.js <fires.jsonl> <sample60.txt>");
	process.exit(2);
}

const { rows, unparsed } = parseRows(fs.readFileSync(firesPath, "utf8"));
const readOnly = rows.filter((r) => !writesSomething(r.c));
console.log(
	JSON.stringify(
		{
			firings: rows.length,
			unparsedLines: unparsed,
			writesSomething: rows.length - readOnly.length,
			readOnly: readOnly.length,
			falseWarnRate: +(readOnly.length / Math.max(1, rows.length)).toFixed(3),
		},
		null,
		2,
	),
);

/*
 * The hand-check sample, drawn by a seeded LCG rather than Math.random so
 * mantahostels#2854's own 60 commands can be redrawn from the same corpus. The constants
 * are glibc's `rand`; nothing here needs a good generator, only a repeatable
 * one.
 */
let seed = 2854;
const rnd = () => {
	seed = (seed * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
	return seed / 0x7f_ff_ff_ff;
};

// 400 characters is enough to carry the write call the verdict turns on in
// every command mantahostels#2854 read by hand; a longer command is truncated and its
// verdict must be re-derived from the corpus rather than from this file.
const EXCERPT = 400;
const pick = [];
const seen = new Set();
while (pick.length < 60 && seen.size < rows.length) {
	const i = Math.floor(rnd() * rows.length);
	if (seen.has(i)) continue;
	seen.add(i);
	// rnd() is 1 only at seed 0x7fffffff, which no draw from 2854 reaches in
	// 4e9 steps, so a draw past the end is a broken invariant.
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
