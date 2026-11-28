#!/usr/bin/env node

const { runCheck } = require("./lib/check");
const { exemptHint, exemptMarker } = require("./lib/exempt-markers.js");
const { parseLineSites, heresySpec } = require("./lib/heresy-scan.js");

// measured 12 lines in lib/pending-tasks.js, #3452
const WINDOW = 12;
const NEWLINE_SPLIT =
	/\.split\(\s*(?:"\\n"|'\\n'|`\\n`|\/\\n\/|\/\\r\?\\n\/)\s*\)/;
const PARSE = /\bJSON\.parse\b/;
// #5869
const MAPPED =
	/\.(?:flatMap|map)\(\s*(?:\(?\w+\)?\s*=>\s*)?([A-Za-z_$][\w$]*)[,)(]/g;
// guess: a bound on a helper body's scan should its braces never balance, #5869
const BODY_CAP = 200;
const EXEMPT = exemptMarker("jsonl-read");
const READER = "scripts/lib/jsonl.js";

const FIX = `read it through readJsonl (a file), parseJsonl (text) or parseJsonlRow (one streamed line) in ${READER}, as scripts/lib/dispatch-ledger.js's readCountedRows does; or mark it ${exemptHint("jsonl-read")}, an issue saying the text is no JSONL (#3452).`;

/**
 * @param {string[]} lines
 * @param {string} name
 */
function helperParses(lines, name) {
	const def = new RegExp(
		`(?:\\bfunction\\s+${name}\\s*\\(|\\b(?:const|let|var)\\s+${name}\\s*=)`,
	);
	const start = lines.findIndex((l) => def.test(l));
	if (start === -1) return false;
	let depth = 0;
	for (const line of lines.slice(start, start + BODY_CAP)) {
		if (PARSE.test(line)) return true;
		depth += (line.match(/[{(]/g) ?? []).length;
		depth -= (line.match(/[})]/g) ?? []).length;
		if (depth <= 0 && /[;}]\s*$/.test(line)) return false;
	}
	return false;
}

/** @param {string[]} window @param {string[]} lines */
const parsesNear = (window, lines) =>
	window.some(
		(l) =>
			PARSE.test(l) ||
			[...l.matchAll(MAPPED)].some((m) => helperParses(lines, m[1] ?? "")),
	);

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
						parsesNear(lines.slice(i, i + WINDOW + 1), lines),
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
