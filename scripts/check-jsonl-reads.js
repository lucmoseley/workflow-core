#!/usr/bin/env node
/*
 * check-jsonl-reads.js — every JSONL read goes through lib/jsonl.js, never a
 * hand split-and-parse with its own answer for a torn last line (#3452).
 *
 * Usage:
 *   node check-jsonl-reads.js [--root <dir>] [--against <rev>] [--json] [--warn]
 *
 * STOPGAP, DIRECTION-GATED until #3453 makes it whole-tree.
 * `.husky/pre-commit` runs this under `--against HEAD`, so a site a commit
 * adds refuses and an inherited one warns; a bare run FAILs on every site. A
 * site's identity is its file and its line's text with its
 * occurrence number, so an edit elsewhere in the file leaves it inherited.
 *
 * LEXICAL. A site is a `.split(...)` on a newline (`"\n"`, `'\n'`, `` `\n` ``,
 * `/\n/` or `/\r?\n/`) with a `JSON.parse` on that line or the WINDOW lines
 * after it, comments aside, in any non-test `.js`, `.cjs` or `.mjs` under
 * scripts/.
 *
 * THE OPT-OUT is a `jsonl-read-exempt: <why>` comment on the split's line or
 * the line above, for newline-split text that is no JSONL beside an unrelated
 * parse. A marker with no word after it is no marker.
 *
 * IMPLICIT:  on every commit staging a scripts/ program, refuses a hand split-and-parse of JSONL the commit adds, naming the file, line and lib/jsonl.js.
 * JUSTIFIED: fail-safe — each hand parse answers a torn last line its own way; the fix is one readJsonl or parseJsonl call.
 * DEFEAT:    the `jsonl-read-exempt: <why>` marker; --warn caps findings below the gating line; a parse further than WINDOW lines from its split, a split on a variable, or a line-by-line `readline` read.
 */

const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./lib/host-root.js");
const { scanJs } = require("./lib/strip-comments.js");

/** @typedef {import("./lib/check").CheckContext} Ctx */
const { runCheck } = require("./lib/check");

/* The widest split-to-parse gap among the sites live at #3452:
 * lib/pending-tasks.js, 12 lines. */
const WINDOW = 12;
const NEWLINE_SPLIT =
	/\.split\(\s*(?:"\\n"|'\\n'|`\\n`|\/\\n\/|\/\\r\?\\n\/)\s*\)/;
const PARSE = /\bJSON\.parse\b/;
const EXEMPT = /jsonl-read-exempt:\s*\w/;
const PROGRAM = /\.(?:c|m)?js$/;
const TEST = /\.test\.[cm]?[jt]s$/;
const READER = "scripts/lib/jsonl.js";

const FIX = `read it through readJsonl (a file) or parseJsonl (text) in ${READER}, as scripts/lib/dispatch-ledger.js's readWindowRows does; or mark it \`jsonl-read-exempt: <why>\` where the text is no JSONL (#3452).`;

/**
 * `source` with each comment blanked to spaces, its newlines kept, so a line
 * number in the result is a line number in the file.
 * @param {string} source
 */
function blankComments(source) {
	let out = "";
	let from = 0;
	for (const [start, end] of scanJs(source).comments) {
		out +=
			source.slice(from, start) +
			source.slice(start, end).replace(/[^\n]/g, " ");
		from = end;
	}
	return out + source.slice(from);
}

/**
 * Each hand split-and-parse site in `source`: its 1-based line and its text.
 * @param {string} source
 * @returns {{ line: number, text: string }[]}
 */
function parseSites(source) {
	const raw = source.split("\n");
	const code = blankComments(source).split("\n");
	/** @type {{ line: number, text: string }[]} */
	const found = [];
	for (const [i, line] of code.entries()) {
		if (!NEWLINE_SPLIT.test(line)) continue;
		if (!code.slice(i, i + WINDOW + 1).some((l) => PARSE.test(l))) continue;
		if (raw.slice(Math.max(0, i - 1), i + 1).some((l) => EXEMPT.test(l)))
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
	name: "jsonl-reads",
	usage:
		"node check-jsonl-reads.js [--root <dir>] [--against <rev>] [--json] [--warn]",
	valueFlags: ["--root"],
	against: {
		profile: "jsonl-reads",
		materialise: "blobs",
		pathspecs: () => ["scripts"],
	},
	run(/** @type {Ctx} */ ctx) {
		const root = path.resolve(ctx.value("--root") ?? hostRoot());
		const dir = path.join(root, "scripts");
		/* No scripts/ is zero programs, not SKIP: a SKIP on the HEAD side of
		 * --against is BROKEN, which would refuse the first program ever added. */
		const names = fs.existsSync(dir) ? readPrograms(dir) : [];
		/** @type {string[]} */
		const faulted = [];
		for (const name of names) {
			const rel = `scripts/${name}`;
			if (rel === READER) continue;
			/** @type {Map<string, number>} */
			const seen = new Map();
			for (const site of parseSites(
				fs.readFileSync(path.join(dir, name), "utf8"),
			)) {
				const n = (seen.get(site.text) ?? 0) + 1;
				seen.set(site.text, n);
				faulted.push(`${rel}:${site.line}`);
				ctx.fail(
					"JSONL-READ",
					`${rel}:${site.line} hand-parses JSONL (\`${site.text}\`). Fix: ${FIX}`,
					{ file: rel, match: `${site.text} #${n}` },
				);
			}
		}
		/* One line, not one per site: under --against every commit staging a
		 * program prints this report, inherited sites included. The parent
		 * re-lists a site this commit adds in full. */
		if (faulted.length > 0)
			ctx.say(
				`  ${faulted.length} site(s) hand-parse JSONL: ${faulted.join(", ")}.\n  Fix: ${FIX}`,
			);
		return {
			okLine: `${names.length} program(s), no hand-parsed JSONL.`,
			noun: "hand-parsed JSONL read(s)",
			count: ctx.findings.length,
			data: { scanned: names.length },
		};
	},
});
