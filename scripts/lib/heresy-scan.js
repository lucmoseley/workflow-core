const fs = require("node:fs");
const path = require("node:path");
const { readText } = require("./file-read.js");
const { worktreeRoot } = require("./host-root.js");
const { blankComments } = require("./strip-comments.js");
const { isJsTestFile } = require("./test-kind.js");

/** @typedef {import("./check").Ctx} Ctx */

const PROGRAM = /\.(?:c|m)?js$/;
const REPORT_PROGRAM = /^scripts\/report-[^/]+$/;

/**
 * @typedef {{ line: number, text: string }} Site
 * @typedef {{ source: string, code: string }} Program
 * @typedef {{
 *   tag: string,
 *   sites: (program: Program, rel: string, context: unknown) => Site[],
 *   message: (rel: string, site: Site) => string,
 * }} Breach
 */

/** @param {string} line */
const collapse = (line) => line.trim().replace(/\s+/g, " ");

/**
 * @param {Program} program
 * @param {(line: string, i: number, lines: string[]) => boolean} matches
 * @param {RegExp} [optOut]
 * @returns {Site[]}
 */
function parseLineSites({ source, code }, matches, optOut) {
	const raw = source.split("\n");
	const lines = code.split("\n");
	return lines.flatMap((line, i) =>
		matches(line, i, lines) &&
		!(
			optOut && raw.slice(Math.max(0, i - 1), i + 1).some((l) => optOut.test(l))
		)
			? [{ line: i + 1, text: collapse(line) }]
			: [],
	);
}

/**
 * @param {Program} program
 * @param {RegExp} re
 * @returns {Site[]}
 */
function parseMatchSites({ code }, re) {
	return [...code.matchAll(re)].map((m) => ({
		line: code.slice(0, m.index).split("\n").length,
		text: m[0].replace(/\s+/g, " "),
	}));
}

/**
 * @param {string} root
 * @param {string[]} dirs
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
 * @param {string} root
 * @param {string[]} dirs
 * @param {(rel: string) => boolean} include
 */
const readPrograms = (root, dirs, include) =>
	listTreeFiles(root, dirs)
		.filter((rel) => PROGRAM.test(rel) && !isJsTestFile(rel) && include(rel))
		.sort();

/**
 * @param {string} root
 * @param {string[]} paths
 * @returns {ReadonlyMap<string, string>}
 */
function readBeside(root, paths) {
	/** @type {Map<string, string>} */
	const texts = new Map();
	for (const rel of paths) {
		const read = readText(path.join(root, rel));
		if (read.state === "unreadable") throw read.error;
		if (read.state === "read") texts.set(rel, read.data);
	}
	return texts;
}

/**
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
 * @param {{ rel: string, context: unknown }} at
 * @param {Program} program
 * @param {Breach[]} breaches
 */
function failSites(ctx, { rel, context }, program, breaches) {
	for (const { tag, sites, message } of breaches) {
		/** @type {Map<string, number>} */
		const seen = new Map();
		for (const site of sites(program, rel, context)) {
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
 * @param {{
 *   name: string,
 *   dirs?: string[],
 *   reads?: { paths: string[], parse: (texts: ReadonlyMap<string, string>) => unknown },
 *   include?: (rel: string) => boolean,
 *   skip?: string[],
 *   breaches: Breach[],
 *   summary?: { phrase: string, fix: string },
 *   finish: (ctx: Ctx, scanned: number) => { okLine: string, noun: string },
 * }} spec
 * @returns {import("./check").CheckSpec}
 */
function heresySpec({
	name: checkName,
	dirs = ["scripts"],
	reads = { paths: [], parse: () => undefined },
	include = () => true,
	skip = [],
	breaches,
	summary,
	finish,
}) {
	return {
		name: checkName,
		usage: `node check-${checkName}.js [--root <dir>] [--against <rev>] [--index] [--json] [--warn]`,
		valueFlags: ["--root"],
		against: {
			profile: checkName,
			materialise: "blobs",
			pathspecs: () => [...dirs, ...reads.paths],
		},
		run(/** @type {Ctx} */ ctx) {
			const root = path.resolve(ctx.value("--root") ?? worktreeRoot());
			const names = readPrograms(root, dirs, include);
			const context = reads.parse(readBeside(root, reads.paths));
			for (const rel of names) {
				if (skip.includes(rel)) continue;
				const source = fs.readFileSync(path.join(root, rel), "utf8");
				failSites(
					ctx,
					{ rel, context },
					{ source, code: blankComments(source) },
					breaches,
				);
			}
			if (summary)
				saySites(ctx, `site(s) ${summary.phrase}`, [`Fix: ${summary.fix}`]);
			return {
				...finish(ctx, names.length),
				count: ctx.findings.length,
				data: { scanned: names.length },
			};
		},
	};
}

module.exports = {
	REPORT_PROGRAM,
	listTreeFiles,
	parseLineSites,
	parseMatchSites,
	heresySpec,
	saySites,
};
