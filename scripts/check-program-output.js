#!/usr/bin/env node
/*
 * check-program-output.js — a program that ends in process.exit writes its
 * output through writeFd, never `console` or a std stream's own write, so a
 * pipe keeps the tail (base §N6; workflow-core#4018, workflow-core#3454).
 *
 * Usage:
 *   node check-program-output.js [--root <dir>] [--against <rev>] [--index] [--json] [--warn]
 *
 * LEXICAL, over every program under scripts/ and .claude/skills/<skill>/scripts/
 * that is not a test, test support (lib/test-kind.js's isTestKind) or a
 * scripts/templates/ file, with comments and literals blanked, so text a
 * program emits as code is no write.
 * One is in scope where it calls `process.exit`, and a `report-*` directly
 * under scripts/ always, read with only its comments blanked. A site is any reach for `console`, `process.stdout.write`
 * or `process.stderr.write`, an alias included.
 *
 * THE OPT-OUT is a `console-kept: <why>` comment on the site's line or the line
 * above — §N6's terminal-only path, or a reach that is no write. A marker with
 * no word after it is no marker, and a `report-*` honours none.
 *
 * IMPLICIT:  on every commit staging a scripts/ or skill program, refuses any program in the tree that calls process.exit and writes past writeFd, naming the file, line, writeFd and its exemplar.
 * JUSTIFIED: fail-safe — process.exit drops what node still holds for a pipe, so the tail of a piped report is lost without a word.
 * DEFEAT:    the `console-kept: <why>` marker; --warn caps findings below the gating line; console reached through a destructure or `globalThis`, an exit reached through an alias, or, outside a report-*, a write inside a template's `${…}`.
 */

const {
	REPORT_PROGRAM,
	parseMatchSites,
	runHeresyCheck,
} = require("./lib/heresy-scan.js");
const { blankInert } = require("./lib/strip-comments.js");
const { isTestKind } = require("./lib/test-kind.js");

const SKILL_PROGRAM = /^\.claude\/skills\/[^/]+\/scripts\//;
const EXIT = /\bprocess\.exit\s*\(/;
/* A call is matched whole so its message quotes it; any other reach for
 * console or a std stream, an alias or a bracket access, is matched bare. */
const OUTPUT =
	/\b(?:console\s*\.\s*\w+|process\.std(?:out|err)\.write)\s*\(|\bconsole\s*[.[]|\bprocess\.std(?:out|err)\.write\b/g;
const KEPT = /console-kept:\s*\w/;

const FIX =
	"write through writeFd in scripts/lib/write-fd.js, as scripts/check-plugin-gap.js does, or on a path only a human runs at a terminal mark the site `console-kept: <why>` (§N6).";

/** @param {string} rel */
const include = (rel) =>
	!isTestKind(rel) &&
	!rel.startsWith("scripts/templates/") &&
	(rel.startsWith("scripts/") || SKILL_PROGRAM.test(rel));

runHeresyCheck({
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
				return parseMatchSites({ ...program, code }, OUTPUT, KEPT);
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
