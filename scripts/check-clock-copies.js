#!/usr/bin/env node
/*
 * check-clock-copies.js — every program reads the clock through `now()` in
 * lib/check.js, never its own parse of WFC_NOW, so a pinned clock pins every
 * program (#3457).
 *
 * Usage:
 *   node check-clock-copies.js [--root <dir>] [--against <rev>] [--json] [--warn]
 *
 * LEXICAL. A site is a read of WFC_NOW — `.WFC_NOW`, `["WFC_NOW"]` or a
 * destructuring `{ … WFC_NOW … } =` on one line — in the code, comments
 * aside, of any non-test `.js`, `.cjs` or `.mjs` under scripts/ but
 * lib/check.js. A guard core, whose environment is its injected `ctx.env`,
 * calls `now(ctx.env)` (#3566).
 *
 * THE OPT-OUT is a `clock-kept: <why>` comment on the read's line or the line
 * above. A marker with no word after it is no marker.
 *
 * IMPLICIT:  on every commit staging a scripts/ program, refuses any WFC_NOW read outside lib/check.js in the tree, naming the file, line, `now()` and its exemplar.
 * JUSTIFIED: fail-safe — each copy answers a malformed pin its own way, and one a test does not pin reads the wall clock; the fix is one `now()` call.
 * DEFEAT:    the `clock-kept: <why>` marker; --warn caps findings below the gating line; a read split across lines, or one through a computed key.
 */

const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./lib/host-root.js");
const { blankComments } = require("./lib/js-lex.js");

/** @typedef {import("./lib/check").CheckContext} Ctx */
const { runCheck } = require("./lib/check");

/* Built from VAR, so this file's own patterns read as no site. */
const VAR = "WFC_NOW";
const READ_SHAPES = [
	new RegExp(`\\.${VAR}\\b`),
	new RegExp(`\\[\\s*(["'\`])${VAR}\\1\\s*\\]`),
	new RegExp(`\\{[^}]*\\b${VAR}\\b[^}]*\\}\\s*=(?![=>])`),
];
const KEPT = /clock-kept:\s*\w/;
const PROGRAM = /\.(?:c|m)?js$/;
const TEST = /\.test\.[cm]?[jt]s$/;
const CLOCK = "scripts/lib/check.js";

const FIX = `call now() from ${CLOCK}, as scripts/check-history-trim.js does, where runCheck turns its throw on a malformed WFC_NOW into BROKEN; outside runCheck, catch that throw as scripts/lib/log-reading.js's now does; in a guard core, pass its env as scripts/lib/sweep-fire-host.js's now(env) does; or mark the read \`clock-kept: <why>\` (#3457).`;

/**
 * Each WFC_NOW read in `source`: its 1-based line and its text.
 * @param {string} source
 * @returns {{ line: number, text: string }[]}
 */
function parseSites(source) {
	const raw = source.split("\n");
	/** @type {{ line: number, text: string }[]} */
	const found = [];
	for (const [i, line] of blankComments(source).split("\n").entries()) {
		if (!READ_SHAPES.some((re) => re.test(line))) continue;
		if (raw.slice(Math.max(0, i - 1), i + 1).some((l) => KEPT.test(l)))
			continue;
		found.push({ line: i + 1, text: line.trim().replace(/\s+/g, " ") });
	}
	return found;
}

/**
 * Every non-test program under `dir`, as paths relative to it, sorted.
 * @param {string} dir
 */
function readPrograms(dir) {
	return fs
		.readdirSync(dir, { recursive: true, encoding: "utf8" })
		.filter(
			(rel) =>
				PROGRAM.test(rel) &&
				!TEST.test(rel) &&
				!rel.split(path.sep).includes("node_modules"),
		)
		.map((rel) => rel.split(path.sep).join("/"))
		.sort();
}

runCheck({
	name: "clock-copies",
	usage:
		"node check-clock-copies.js [--root <dir>] [--against <rev>] [--json] [--warn]",
	valueFlags: ["--root"],
	against: {
		profile: "clock-copies",
		materialise: "blobs",
		pathspecs: () => ["scripts"],
	},
	run(/** @type {Ctx} */ ctx) {
		const root = path.resolve(ctx.value("--root") ?? hostRoot());
		const dir = path.join(root, "scripts");
		/* No scripts/ is zero programs, not SKIP: a SKIP on the HEAD side of
		 * --against is BROKEN, which would refuse the first program ever added. */
		const names = fs.existsSync(dir) ? readPrograms(dir) : [];
		for (const name of names) {
			const rel = `scripts/${name}`;
			if (rel === CLOCK) continue;
			/** @type {Map<string, number>} */
			const seen = new Map();
			for (const site of parseSites(
				fs.readFileSync(path.join(dir, name), "utf8"),
			)) {
				const n = (seen.get(site.text) ?? 0) + 1;
				seen.set(site.text, n);
				ctx.fail(
					"CLOCK-COPY",
					`${rel}:${site.line} reads WFC_NOW itself (\`${site.text}\`). Fix: ${FIX}`,
					{ file: rel, line: site.line, match: `${site.text} #${n}` },
				);
			}
		}
		if (ctx.findings.length > 0)
			ctx.say(
				`  ${ctx.findings.length} site(s) read WFC_NOW outside now(): ${ctx.findings.map((f) => `${f.file}:${f.line}`).join(", ")}.\n  Fix: ${FIX}`,
			);
		return {
			okLine: `${names.length} program(s), no WFC_NOW read outside now().`,
			noun: "WFC_NOW read(s) outside now()",
			count: ctx.findings.length,
			data: { scanned: names.length },
		};
	},
});
