#!/usr/bin/env node
/*
 * check-jsonl-reads.js — every JSONL read goes through lib/jsonl.js, never a
 * hand split-and-parse with its own answer for a torn last line (#3452).
 *
 * Usage:
 *   node check-jsonl-reads.js [--root <dir>] [--against <rev>] [--index] [--json] [--warn]
 *
 * `.husky/pre-commit` runs it over the whole tree (#3453).
 *
 * LEXICAL. A site is a `.split(...)` on a newline (`"\n"`, `'\n'`, `` `\n` ``,
 * `/\n/` or `/\r?\n/`) with a `JSON.parse` on that line or the WINDOW lines
 * after it, comments aside, in any non-test `.js`, `.cjs` or `.mjs` under
 * scripts/. lib/heresy-scan.js lists and reads the programs (#3555).
 *
 * THE OPT-OUT is a `jsonl-read-exempt: <why>` comment on the split's line or
 * the line above, for newline-split text that is no JSONL beside an unrelated
 * parse. A marker with no word after it is no marker.
 *
 * IMPLICIT:  on every commit staging a scripts/ program, refuses any hand split-and-parse of JSONL in the tree, naming the file, line, lib/jsonl.js and its exemplar.
 * JUSTIFIED: fail-safe — each hand parse answers a torn last line its own way; the fix is one readJsonl, parseJsonl or parseJsonlRow call.
 * DEFEAT:    the `jsonl-read-exempt: <why>` marker; --warn caps findings below the gating line; a parse further than WINDOW lines from its split, a split on a variable, or a line-by-line `readline` read.
 */

const { parseLineSites, runHeresyCheck } = require("./lib/heresy-scan.js");

/* The widest split-to-parse gap among the sites live at #3452:
 * lib/pending-tasks.js, 12 lines. */
const WINDOW = 12;
const NEWLINE_SPLIT =
	/\.split\(\s*(?:"\\n"|'\\n'|`\\n`|\/\\n\/|\/\\r\?\\n\/)\s*\)/;
const PARSE = /\bJSON\.parse\b/;
const EXEMPT = /jsonl-read-exempt:\s*\w/;
const READER = "scripts/lib/jsonl.js";

const FIX = `read it through readJsonl (a file), parseJsonl (text) or parseJsonlRow (one streamed line) in ${READER}, as scripts/lib/dispatch-ledger.js's readWindowRows does; or mark it \`jsonl-read-exempt: <why>\` where the text is no JSONL (#3452).`;

runHeresyCheck({
	name: "jsonl-reads",
	skip: [READER],
	breaches: [
		{
			tag: "JSONL-READ",
			sites: (program) =>
				parseLineSites(
					program,
					(line, i, lines) =>
						NEWLINE_SPLIT.test(line) &&
						lines.slice(i, i + WINDOW + 1).some((l) => PARSE.test(l)),
					EXEMPT,
				),
			message: (rel, site) =>
				`${rel}:${site.line} hand-parses JSONL (\`${site.text}\`). Fix: ${FIX}`,
		},
	],
	summary: { phrase: "hand-parse JSONL", fix: FIX },
	finish(_ctx, scanned) {
		return {
			okLine: `${scanned} program(s), no hand-parsed JSONL.`,
			noun: "hand-parsed JSONL read(s)",
		};
	},
});
