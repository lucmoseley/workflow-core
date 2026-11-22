#!/usr/bin/env node

const { runCheck } = require("./lib/check");
const { parseLineSites, heresySpec } = require("./lib/heresy-scan.js");

// measured 12 lines in lib/pending-tasks.js, #3452
const WINDOW = 12;
const NEWLINE_SPLIT =
	/\.split\(\s*(?:"\\n"|'\\n'|`\\n`|\/\\n\/|\/\\r\?\\n\/)\s*\)/;
const PARSE = /\bJSON\.parse\b/;
const EXEMPT = /jsonl-read-exempt:\s*\w/;
const READER = "scripts/lib/jsonl.js";

const FIX = `read it through readJsonl (a file), parseJsonl (text) or parseJsonlRow (one streamed line) in ${READER}, as scripts/lib/dispatch-ledger.js's readCountedRows does; or mark it \`jsonl-read-exempt: <why>\` where the text is no JSONL (#3452).`;

/** @type {import("./lib/check").CheckSpec} */
const SPEC = heresySpec({
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

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
