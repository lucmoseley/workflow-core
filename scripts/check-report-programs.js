#!/usr/bin/env node
/*
 * check-report-programs.js — a `report-*` program writes through writeFd and
 * files through createIssue, never `console` or a `gh issue create` of its
 * own (#3454).
 *
 * Usage:
 *   node check-report-programs.js [--root <dir>] [--against <rev>] [--json] [--warn]
 *
 * LEXICAL, over every non-test `scripts/report-*.js`, `.cjs` or `.mjs`, with
 * comments blanked; lib/heresy-scan.js lists and reads the programs (#3555).
 * Two breaches:
 *   - OUTPUT: any reach for `console`, `process.stdout.write` or
 *     `process.stderr.write`, an alias included.
 *   - ISSUE-CREATE: an `"issue", "create"` argument pair or an `issue create`
 *     string, which files past scripts/lib/tracking-issue.js's createIssue
 *     (base §N3; lucmoseley/mantahostels#2762).
 *
 * IMPLICIT:  on every commit staging a scripts/report-* program, refuses any report-* in the tree writing past writeFd or filing past createIssue, naming the file, line, the primitive and its exemplar.
 * JUSTIFIED: fail-safe — a report-* ends in process.exit on a pipe, where console output is lost, and a second filing route drifts from the first.
 * DEFEAT:    --warn caps findings below the gating line; console reached through a destructure or `globalThis`, or a create through `gh api` on the issues endpoint.
 */

const { matchSites, runHeresyCheck } = require("./lib/heresy-scan.js");

/* Directly under scripts/: `[^/]+` keeps a subdirectory's file out. */
const REPORT = /^report-[^/]+$/;
/* A call is matched whole so its message quotes it; any other reach for
 * console or a std stream, an alias or a bracket access, is matched bare. */
const OUTPUT =
	/\b(?:console\s*\.\s*\w+|process\.std(?:out|err)\.write)\s*\(|\bconsole\s*[.[]|\bprocess\.std(?:out|err)\.write\b/g;
const ISSUE_CREATE = /(["'`])issue\1\s*,\s*(["'`])create\2|\bissue\s+create\b/g;

const OUTPUT_FIX =
	"write through writeFd in scripts/lib/write-fd.js, as scripts/report-new-shared-faults.js does (§N6).";
const CREATE_FIX =
	"file through createIssue in scripts/lib/tracking-issue.js, as scripts/report-remeasure-due.js does, or its fileOrRefresh (§N3).";

runHeresyCheck({
	name: "report-programs",
	include: (rel) => REPORT.test(rel),
	breaches: [
		{
			tag: "REPORT-OUTPUT",
			sites: (program) => matchSites(program, OUTPUT),
			message: (rel, site) =>
				`${rel}:${site.line} writes past writeFd (\`${site.text}\`). Fix: ${OUTPUT_FIX}`,
		},
		{
			tag: "REPORT-ISSUE-CREATE",
			sites: (program) => matchSites(program, ISSUE_CREATE),
			message: (rel, site) =>
				`${rel}:${site.line} files past createIssue (\`${site.text}\`). Fix: ${CREATE_FIX}`,
		},
	],
	finish(ctx, scanned) {
		for (const f of ctx.findings) ctx.say(`  ${f.message}`);
		return {
			okLine: `${scanned} report program(s), each writing through writeFd and filing through createIssue.`,
			noun: "report-program breach(es)",
		};
	},
});
