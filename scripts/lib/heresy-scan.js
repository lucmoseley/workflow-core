/*
 * heresy-scan.js — the whole-tree lexical heresy check's shell (workflow-core#3555). A
 * finding is keyed by its site's text and occurrence number in the file, so
 * the key survives a line shift above it. A check brings only its site
 * patterns, its opt-out marker, its fix text and its okLine. A lexical check
 * with a walk or report of its own still lists its tree through
 * listTreeFiles and summarises its sites through saySites (workflow-core#4123).
 */

const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./host-root.js");
const { blankComments } = require("./strip-comments.js");
const { isJsTestFile } = require("./test-kind.js");

/** @typedef {import("./check").CheckContext} Ctx */
const { runCheck } = require("./check");

const PROGRAM = /\.(?:c|m)?js$/;
/* A `report-*` program: directly under scripts/, `[^/]+` keeping a
 * subdirectory's file out. */
const REPORT_PROGRAM = /^scripts\/report-[^/]+$/;

/**
 * @typedef {{ line: number, text: string }} Site
 * @typedef {{ source: string, code: string }} Program  the file's text, and
 *   that text with each comment blanked to spaces, its newlines kept
 * @typedef {{
 *   tag: string,
 *   sites: (program: Program, rel: string) => Site[],
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
function parseLineSites({ source, code }, matches, optOut) {
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
 * Each match of the global `re` in the blanked code, its text collapsed, but
 * one whose line or the line above carries `optOut` in the raw text.
 * @param {Program} program
 * @param {RegExp} re
 * @param {RegExp} [optOut]
 * @returns {Site[]}
 */
function parseMatchSites({ source, code }, re, optOut) {
	const raw = source.split("\n");
	return [...code.matchAll(re)]
		.map((m) => ({
			line: code.slice(0, m.index).split("\n").length,
			text: m[0].replace(/\s+/g, " "),
		}))
		.filter(
			({ line }) =>
				!optOut ||
				!raw.slice(Math.max(0, line - 2), line).some((l) => optOut.test(l)),
		);
}

/**
 * Every file under each of `dirs`, as a path relative to `root` with `/`
 * separators: each dir's files sorted, the dirs in `dirs`' order. A
 * `node_modules` directory is never entered, and a symlink is never followed
 * or listed.
 * @param {string} root
 * @param {string[]} dirs  relative to `root`, `/`-separated; one that is
 *   missing holds none
 * @returns {string[]}
 */
function listTreeFiles(root, dirs) {
	/**
	 * @param {string} rel
	 * @returns {string[]}
	 */
	const walk = (rel) =>
		fs
			.readdirSync(path.join(root, rel), { withFileTypes: true })
			.flatMap((entry) => {
				if (entry.name === "node_modules") return [];
				const name = `${rel}/${entry.name}`;
				if (entry.isDirectory()) return walk(name);
				return entry.isFile() ? [name] : [];
			});
	return dirs.flatMap((dir) =>
		fs.existsSync(path.join(root, dir)) ? walk(dir).sort() : [],
	);
}

/**
 * Every non-test program under each of `dirs` that `include` takes, sorted
 * across them all.
 * @param {string} root
 * @param {string[]} dirs
 * @param {(rel: string) => boolean} include
 */
const readPrograms = (root, dirs, include) =>
	listTreeFiles(root, dirs)
		.filter((rel) => PROGRAM.test(rel) && !isJsTestFile(rel) && include(rel))
		.sort();

/**
 * Where there are findings, say their count, `phrase` and each site on one
 * line, then each of `fixes` on its own.
 * @param {Ctx} ctx
 * @param {string} phrase
 * @param {string[]} fixes
 */
function saySites(ctx, phrase, fixes) {
	if (ctx.findings.length === 0) return;
	ctx.say(
		[
			`${ctx.findings.length} ${phrase}: ${ctx.findings.map((f) => `${f.file}:${f.line}`).join(", ")}.`,
			...fixes,
		]
			.map((line) => `  ${line}`)
			.join("\n"),
	);
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
		for (const site of sites(program, rel)) {
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
 * Run one heresy check over `dirs` in the tree at `--root`, or the host root.
 * `include` takes a repo-relative path; `skip` names the primitive's own home,
 * repo-relative. Where `summary` is given, any finding prints two
 * lines: the count, its `phrase` and each site, then its `fix`.
 * @param {{
 *   name: string,
 *   dirs?: string[],
 *   include?: (rel: string) => boolean,
 *   skip?: string[],
 *   breaches: Breach[],
 *   summary?: { phrase: string, fix: string },
 *   finish: (ctx: Ctx, scanned: number) => { okLine: string, noun: string },
 * }} spec
 */
function runHeresyCheck({
	name: checkName,
	dirs = ["scripts"],
	include = () => true,
	skip = [],
	breaches,
	summary,
	finish,
}) {
	runCheck({
		name: checkName,
		usage: `node check-${checkName}.js [--root <dir>] [--against <rev>] [--index] [--json] [--warn]`,
		valueFlags: ["--root"],
		against: {
			profile: checkName,
			materialise: "blobs",
			pathspecs: () => dirs,
		},
		run(/** @type {Ctx} */ ctx) {
			const root = path.resolve(ctx.value("--root") ?? hostRoot());
			/* A missing dir is zero programs, not SKIP: a SKIP on the HEAD side of
			 * --against is BROKEN, which would refuse the first program ever added. */
			const names = readPrograms(root, dirs, include);
			for (const rel of names) {
				if (skip.includes(rel)) continue;
				const source = fs.readFileSync(path.join(root, rel), "utf8");
				failSites(ctx, rel, { source, code: blankComments(source) }, breaches);
			}
			if (summary)
				saySites(ctx, `site(s) ${summary.phrase}`, [`Fix: ${summary.fix}`]);
			return {
				...finish(ctx, names.length),
				count: ctx.findings.length,
				data: { scanned: names.length },
			};
		},
	});
}

module.exports = {
	REPORT_PROGRAM,
	listTreeFiles,
	parseLineSites,
	parseMatchSites,
	runHeresyCheck,
	saySites,
};
