/*
 * heresy-scan.js — the whole-tree lexical heresy check's shell (#3555). A
 * finding is keyed by its site's text and occurrence number in the file, so
 * the key survives a line shift above it. A check brings only its site
 * patterns, its opt-out marker, its fix text and its okLine.
 */

const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./host-root.js");
const { blankComments } = require("./strip-comments.js");
const { isJsTestFile } = require("./test-kind.js");

/** @typedef {import("./check").CheckContext} Ctx */
const { runCheck } = require("./check");

const PROGRAM = /\.(?:c|m)?js$/;

/**
 * @typedef {{ line: number, text: string }} Site
 * @typedef {{ source: string, code: string }} Program  the file's text, and
 *   that text with each comment blanked to spaces, its newlines kept
 * @typedef {{
 *   tag: string,
 *   sites: (program: Program) => Site[],
 *   message: (rel: string, site: Site) => string,
 * }} Breach
 */

/** @param {string} line */
const collapse = (line) => line.trim().replace(/\s+/g, " ");

/**
 * Each code line `matches` picks, by its index among the blanked lines, but
 * one whose line or the line above carries `optOut` in the raw text.
 * @param {Program} program
 * @param {(line: string, i: number, lines: string[]) => boolean} matches
 * @param {RegExp} optOut
 * @returns {Site[]}
 */
function lineSites({ source, code }, matches, optOut) {
	const raw = source.split("\n");
	const lines = code.split("\n");
	return lines.flatMap((line, i) =>
		matches(line, i, lines) &&
		!raw.slice(Math.max(0, i - 1), i + 1).some((l) => optOut.test(l))
			? [{ line: i + 1, text: collapse(line) }]
			: [],
	);
}

/**
 * Each match of the global `re` in the blanked code, its text collapsed.
 * @param {Program} program
 * @param {RegExp} re
 * @returns {Site[]}
 */
function matchSites({ code }, re) {
	return [...code.matchAll(re)].map((m) => ({
		line: code.slice(0, m.index).split("\n").length,
		text: m[0].replace(/\s+/g, " "),
	}));
}

/**
 * Every non-test program under `dir` that `include` takes, as paths
 * relative to it with `/` separators, sorted.
 * @param {string} dir
 * @param {(rel: string) => boolean} include
 */
function readPrograms(dir, include) {
	return fs
		.readdirSync(dir, { recursive: true, encoding: "utf8" })
		.map((rel) => rel.split(path.sep).join("/"))
		.filter(
			(rel) =>
				PROGRAM.test(rel) &&
				!isJsTestFile(rel) &&
				!rel.split("/").includes("node_modules") &&
				include(rel),
		)
		.sort();
}

/**
 * @param {Ctx} ctx
 * @param {string} rel
 * @param {Program} program
 * @param {Breach[]} breaches
 */
function failSites(ctx, rel, program, breaches) {
	for (const { tag, sites, message } of breaches) {
		/** @type {Map<string, number>} */
		const seen = new Map();
		for (const site of sites(program)) {
			const n = (seen.get(site.text) ?? 0) + 1;
			seen.set(site.text, n);
			ctx.fail(tag, message(rel, site), {
				file: rel,
				line: site.line,
				match: `${site.text} #${n}`,
			});
		}
	}
}

/**
 * Run one heresy check over the tree at `--root`, or the host root.
 * `include` takes a path relative to scripts/; `skip` names the primitive's
 * own home, repo-relative.
 * @param {{
 *   name: string,
 *   include?: (rel: string) => boolean,
 *   skip?: string[],
 *   breaches: Breach[],
 *   finish: (ctx: Ctx, scanned: number) => { okLine: string, noun: string },
 * }} spec
 */
function runHeresyCheck({
	name: checkName,
	include = () => true,
	skip = [],
	breaches,
	finish,
}) {
	runCheck({
		name: checkName,
		usage: `node check-${checkName}.js [--root <dir>] [--against <rev>] [--index] [--json] [--warn]`,
		valueFlags: ["--root"],
		against: {
			profile: checkName,
			materialise: "blobs",
			pathspecs: () => ["scripts"],
		},
		run(/** @type {Ctx} */ ctx) {
			const root = path.resolve(ctx.value("--root") ?? hostRoot());
			const dir = path.join(root, "scripts");
			/* No scripts/ is zero programs, not SKIP: a SKIP on the HEAD side of
			 * --against is BROKEN, which would refuse the first program ever added. */
			const names = fs.existsSync(dir) ? readPrograms(dir, include) : [];
			for (const name of names) {
				const rel = `scripts/${name}`;
				if (skip.includes(rel)) continue;
				const source = fs.readFileSync(path.join(dir, name), "utf8");
				failSites(ctx, rel, { source, code: blankComments(source) }, breaches);
			}
			return {
				...finish(ctx, names.length),
				count: ctx.findings.length,
				data: { scanned: names.length },
			};
		},
	});
}

module.exports = { lineSites, matchSites, runHeresyCheck };
