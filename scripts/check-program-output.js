#!/usr/bin/env node

const {
	REPORT_PROGRAM,
	parseMatchSites,
	heresySpec,
} = require("./lib/heresy-scan.js");
const { runCheck } = require("./lib/check");
const { blankInert } = require("./lib/strip-comments.js");
const { isTestKind } = require("./lib/test-kind.js");

const SKILL_PROGRAM = /^\.claude\/skills\/[^/]+\/scripts\//;
const EXIT = /\bprocess\.exit\s*\(/;
const OUTPUT =
	/\b(?:console\s*\.\s*\w+|process\.std(?:out|err)\.write)\s*\(|\bconsole\s*[.[]|\bprocess\.std(?:out|err)\.write\b/g;

const FIX =
	"write through writeFd in scripts/lib/write-fd.js, as scripts/guard-plugin-gap.js does, or, on a path only a human runs at a terminal, through writeTerminal from the same file (§N6).";

/** @param {string} rel */
const include = (rel) =>
	!isTestKind(rel) &&
	!rel.startsWith("scripts/templates/") &&
	(rel.startsWith("scripts/") || SKILL_PROGRAM.test(rel));

/** @type {import("./lib/check").CheckSpec} */
const SPEC = heresySpec({
	name: "program-output",
	dirs: ["scripts", ".claude/skills"],
	include,
	breaches: [
		{
			tag: "PROGRAM-OUTPUT",
			sites: (program, rel) => {
				if (REPORT_PROGRAM.test(rel)) return parseMatchSites(program, OUTPUT);
				const code = blankInert(program.source);
				if (!EXIT.test(code)) return [];
				return parseMatchSites({ ...program, code }, OUTPUT);
			},
			message: (rel, site) =>
				`${rel}:${site.line} writes past writeFd before process.exit (\`${site.text}\`). Fix: ${FIX}`,
		},
	],
	finish(ctx, scanned) {
		for (const f of ctx.findings) ctx.say(`  ${f.message}`);
		return {
			okLine: `${scanned} program(s), none ending in process.exit writing past writeFd.`,
			noun: "write(s) past writeFd",
		};
	},
});

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
