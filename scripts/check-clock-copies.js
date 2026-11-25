#!/usr/bin/env node
const { runCheck } = require("./lib/check");
const { parseLineSites, heresySpec } = require("./lib/heresy-scan.js");

const VAR = "WFC_NOW";
const READ_SHAPES = [
	new RegExp(`\\.${VAR}\\b`),
	new RegExp(`\\[\\s*(["'\`])${VAR}\\1\\s*\\]`),
	new RegExp(`\\{[^{}]*\\b${VAR}\\b[^}]*\\}\\s*=(?![=>])`),
];
const CLOCK = "scripts/lib/clock.js";

const FIX = `call now() from ${CLOCK}, as scripts/check-history-trim.js does, where runCheck turns its throw on a malformed WFC_NOW into BROKEN; outside runCheck, catch that throw as scripts/lib/log-reading.js's now does; in a guard core, pass its env as scripts/lib/sweep-fire-host.js's now(env) does (workflow-core#3457).`;

/** @type {import("./lib/check").CheckSpec} */
const SPEC = heresySpec({
	name: "clock-copies",
	skip: [CLOCK],
	breaches: [
		{
			tag: "CLOCK-COPY",
			sites: (program) =>
				parseLineSites(program, (line) =>
					READ_SHAPES.some((re) => re.test(line)),
				),
			message: (rel, site) =>
				`${rel}:${site.line} reads WFC_NOW itself (\`${site.text}\`). Fix: ${FIX}`,
		},
	],
	summary: { phrase: "read WFC_NOW outside now()", fix: FIX },
	finish(_ctx, scanned) {
		return {
			okLine: `${scanned} program(s), no WFC_NOW read outside now().`,
			noun: "WFC_NOW read(s) outside now()",
		};
	},
});

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
