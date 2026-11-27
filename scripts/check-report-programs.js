#!/usr/bin/env node

const {
	REPORT_PROGRAM,
	parseMatchSites,
	heresySpec,
} = require("./lib/heresy-scan.js");
const { runCheck } = require("./lib/check");
const ISSUE_CREATE = /(["'`])issue\1\s*,\s*(["'`])create\2|\bissue\s+create\b/g;

const CREATE_FIX =
	"file through createIssue in scripts/lib/tracking-issue.js, as scripts/report-remeasure-due.js does, or its fileOrRefresh (§N3).";

/** @type {import("./lib/check").CheckSpec} */
const SPEC = heresySpec({
	name: "report-programs",
	include: (rel) => REPORT_PROGRAM.test(rel),
	breaches: [
		{
			tag: "REPORT-ISSUE-CREATE",
			sites: (program) => parseMatchSites(program, ISSUE_CREATE),
			message: (rel, site) =>
				`${rel}:${site.line} files past createIssue (\`${site.text}\`). Fix: ${CREATE_FIX}`,
		},
	],
	finish(ctx, scanned) {
		for (const f of ctx.findings) ctx.say(`  ${f.message}`);
		return {
			okLine: `${scanned} report program(s), each filing through createIssue.`,
			noun: "report-program breach(es)",
		};
	},
});

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
