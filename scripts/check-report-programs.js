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
 * comments blanked. Two breaches:
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

const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./lib/host-root.js");
const { blankComments } = require("./lib/js-lex.js");

/** @typedef {import("./lib/check").CheckContext} Ctx */
const { runCheck } = require("./lib/check");

const REPORT = /^report-[^/]+\.(?:c|m)?js$/;
const TEST = /\.test\.[cm]?[jt]s$/;
/* A call is matched whole so its message quotes it; any other reach for
 * console or a std stream, an alias or a bracket access, is matched bare. */
const OUTPUT =
	/\b(?:console\s*\.\s*\w+|process\.std(?:out|err)\.write)\s*\(|\bconsole\s*[.[]|\bprocess\.std(?:out|err)\.write\b/g;
const ISSUE_CREATE = /(["'`])issue\1\s*,\s*(["'`])create\2|\bissue\s+create\b/g;

const OUTPUT_FIX =
	"write through writeFd in scripts/lib/write-fd.js, as scripts/report-new-shared-faults.js does (§N6).";
const CREATE_FIX =
	"file through createIssue in scripts/lib/tracking-issue.js, as scripts/report-remeasure-due.js does, or its fileOrRefresh (§N3).";

/**
 * Each match of `re` in `code`: its 1-based line and its text, whitespace
 * collapsed.
 * @param {string} code
 * @param {RegExp} re a global regex
 * @returns {{ line: number, text: string }[]}
 */
function parseSites(code, re) {
	return [...code.matchAll(re)].map((m) => ({
		line: code.slice(0, m.index).split("\n").length,
		text: m[0].replace(/\s+/g, " "),
	}));
}

/**
 * Every non-test report-* program directly under `dir`, sorted.
 * @param {string} dir
 */
function readReports(dir) {
	return fs
		.readdirSync(dir)
		.filter((name) => REPORT.test(name) && !TEST.test(name))
		.sort();
}

runCheck({
	name: "report-programs",
	usage:
		"node check-report-programs.js [--root <dir>] [--against <rev>] [--json] [--warn]",
	valueFlags: ["--root"],
	against: {
		profile: "report-programs",
		materialise: "blobs",
		pathspecs: () => ["scripts"],
	},
	run(/** @type {Ctx} */ ctx) {
		const root = path.resolve(ctx.value("--root") ?? hostRoot());
		const dir = path.join(root, "scripts");
		/* No scripts/ is zero programs, not SKIP: a SKIP on the HEAD side of
		 * --against is BROKEN, which would refuse the first program ever added. */
		const names = fs.existsSync(dir) ? readReports(dir) : [];
		for (const name of names) {
			const rel = `scripts/${name}`;
			const code = blankComments(fs.readFileSync(path.join(dir, name), "utf8"));
			for (const [tag, re, what, fix] of /** @type {const} */ ([
				["REPORT-OUTPUT", OUTPUT, "writes past writeFd", OUTPUT_FIX],
				[
					"REPORT-ISSUE-CREATE",
					ISSUE_CREATE,
					"files past createIssue",
					CREATE_FIX,
				],
			])) {
				/** @type {Map<string, number>} */
				const seen = new Map();
				for (const site of parseSites(code, re)) {
					const n = (seen.get(site.text) ?? 0) + 1;
					seen.set(site.text, n);
					ctx.fail(
						tag,
						`${rel}:${site.line} ${what} (\`${site.text}\`). Fix: ${fix}`,
						{ file: rel, line: site.line, match: `${site.text} #${n}` },
					);
				}
			}
		}
		for (const f of ctx.findings) ctx.say(`  ${f.message}`);
		return {
			okLine: `${names.length} report program(s), each writing through writeFd and filing through createIssue.`,
			noun: "report-program breach(es)",
			count: ctx.findings.length,
			data: { scanned: names.length },
		};
	},
});
