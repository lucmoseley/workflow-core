#!/usr/bin/env node
/*
 * check-clock-copies.js — every program reads the clock through `now()` in
 * lib/check.js, never its own parse of WFC_NOW, so a pinned clock pins every
 * program (#3457).
 *
 * Usage:
 *   node check-clock-copies.js [--root <dir>] [--against <rev>] [--index] [--json] [--warn]
 *
 * LEXICAL. A site is a read of WFC_NOW — `.WFC_NOW`, `["WFC_NOW"]` or a
 * destructuring `{ … WFC_NOW … } =` on one line — in the code, comments
 * aside, of any non-test `.js`, `.cjs` or `.mjs` under scripts/ but
 * lib/check.js. lib/heresy-scan.js lists and reads the programs (#3555). A
 * guard core, whose environment is its injected `ctx.env`, calls
 * `now(ctx.env)` (#3566).
 *
 * THE OPT-OUT is a `clock-kept: <why>` comment on the read's line or the line
 * above. A marker with no word after it is no marker.
 *
 * IMPLICIT:  on every commit staging a scripts/ program, refuses any WFC_NOW read outside lib/check.js in the tree, naming the file, line, `now()` and its exemplar.
 * JUSTIFIED: fail-safe — each copy answers a malformed pin its own way, and one a test does not pin reads the wall clock; the fix is one `now()` call.
 * DEFEAT:    the `clock-kept: <why>` marker; --warn caps findings below the gating line; a read split across lines, or one through a computed key.
 */

const { lineSites, runHeresyCheck } = require("./lib/heresy-scan.js");

/* Built from VAR, so this file's own patterns read as no site. */
const VAR = "WFC_NOW";
const READ_SHAPES = [
	new RegExp(`\\.${VAR}\\b`),
	new RegExp(`\\[\\s*(["'\`])${VAR}\\1\\s*\\]`),
	new RegExp(`\\{[^}]*\\b${VAR}\\b[^}]*\\}\\s*=(?![=>])`),
];
const KEPT = /clock-kept:\s*\w/;
const CLOCK = "scripts/lib/check.js";

const FIX = `call now() from ${CLOCK}, as scripts/check-history-trim.js does, where runCheck turns its throw on a malformed WFC_NOW into BROKEN; outside runCheck, catch that throw as scripts/lib/log-reading.js's now does; in a guard core, pass its env as scripts/lib/sweep-fire-host.js's now(env) does; or mark the read \`clock-kept: <why>\` (#3457).`;

runHeresyCheck({
	name: "clock-copies",
	skip: [CLOCK],
	breaches: [
		{
			tag: "CLOCK-COPY",
			sites: (program) =>
				lineSites(
					program,
					(line) => READ_SHAPES.some((re) => re.test(line)),
					KEPT,
				),
			message: (rel, site) =>
				`${rel}:${site.line} reads WFC_NOW itself (\`${site.text}\`). Fix: ${FIX}`,
		},
	],
	finish(ctx, scanned) {
		if (ctx.findings.length > 0)
			ctx.say(
				`  ${ctx.findings.length} site(s) read WFC_NOW outside now(): ${ctx.findings.map((f) => `${f.file}:${f.line}`).join(", ")}.\n  Fix: ${FIX}`,
			);
		return {
			okLine: `${scanned} program(s), no WFC_NOW read outside now().`,
			noun: "WFC_NOW read(s) outside now()",
		};
	},
});
