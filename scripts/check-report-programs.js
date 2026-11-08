#!/usr/bin/env node
/*
 * check-report-programs.js — a `report-*` program files through createIssue,
 * never a `gh issue create` of its own (#3454). Its output is
 * check-program-output.js's.
 *
 * Usage:
 *   node check-report-programs.js [--root <dir>] [--against <rev>] [--index] [--json] [--warn]
 *
 * LEXICAL, over every non-test `scripts/report-*.js`, `.cjs` or `.mjs`, with
 * comments blanked; lib/heresy-scan.js lists and reads the programs (#3555).
 * A breach is an `"issue", "create"` argument pair or an `issue create`
 * string, which files past scripts/lib/tracking-issue.js's createIssue
 * (base §N3; lucmoseley/mantahostels#2762).
 *
 * IMPLICIT:  on every commit staging a scripts/report-* program, refuses any report-* in the tree filing past createIssue, naming the file, line, createIssue and its exemplar.
 * JUSTIFIED: fail-safe — a second filing route drifts from the first.
 * DEFEAT:    --warn caps findings below the gating line; a create through `gh api` on the issues endpoint.
 */

const {
	REPORT_PROGRAM,
	parseMatchSites,
	runHeresyCheck,
} = require("./lib/heresy-scan.js");
const ISSUE_CREATE = /(["'`])issue\1\s*,\s*(["'`])create\2|\bissue\s+create\b/g;

const CREATE_FIX =
	"file through createIssue in scripts/lib/tracking-issue.js, as scripts/report-remeasure-due.js does, or its fileOrRefresh (§N3).";

runHeresyCheck({
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
