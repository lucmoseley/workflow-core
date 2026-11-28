#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { runCheck } = require("./lib/check");
const { exemptHint, exemptMarker } = require("./lib/exempt-markers.js");
const { dataOrThrow, readText } = require("./lib/file-read.js");
const { parseLineSites, heresySpec } = require("./lib/heresy-scan.js");
const { escapeRe } = require("./lib/regex-group.js");
const { blankComments } = require("./lib/strip-comments.js");

/** @typedef {import("./lib/heresy-scan.js").Program} Program */

// measured 12 lines in lib/pending-tasks.js, #3452
const WINDOW = 12;
const NEWLINE_SPLIT =
	/\.split\(\s*(?:"\\n"|'\\n'|`\\n`|\/\\n\/|\/\\r\?\\n\/)\s*\)/;
const PARSE = /\bJSON\.parse\b/;
const IDENT = "[A-Za-z_$][\\w$]*";
const CALLEE = `${IDENT}(?:\\.${IDENT})*`;
const MAPPED = new RegExp(
	`\\.(?:flatMap|map)\\((?:(${CALLEE})\\s*[,)]|(?:\\w+|\\([\\w, ]*\\)) ?=> ?(${CALLEE})\\()`,
	"g",
);
const CALL = new RegExp(`(?<![\\w$.])(${CALLEE})\\s*\\(`, "g");
const SPECIFIER = `(["'])(\\.{1,2}/[^"']+)\\2`;
const IMPORTS = [
	new RegExp(
		`\\b(?:const|let|var)\\s+(\\{[^}]*\\}|${IDENT})\\s*=\\s*require\\(\\s*${SPECIFIER}\\s*\\)`,
		"g",
	),
	new RegExp(
		`\\bimport\\s+(\\{[^}]*\\}|\\*\\s*as\\s+${IDENT}|${IDENT})\\s+from\\s+${SPECIFIER}`,
		"g",
	),
];
const EXTENSIONS = ["", ".js", ".cjs", ".mjs", "/index.js"];
const SELF = new Set(["this", "exports", "module.exports"]);
const KEYWORDS = new Set(["catch", "for", "function", "if", "switch", "while"]);
const LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
// guess, #5869
const BODY_CAP = 200;
// #5888
const HOPS = 1;
const EXEMPT = exemptMarker("jsonl-read");
const READER = "scripts/lib/jsonl.js";

const FIX = `read it through readJsonl (a file), parseJsonl (text) or parseJsonlRow (one streamed line) in ${READER}, as scripts/lib/dispatch-ledger.js's readCountedRows does; or mark it ${exemptHint("jsonl-read")}, an issue saying the text is no JSONL (#3452).`;

/** @typedef {{ lines: string[], bindings: Map<string, { at: string, name: string | null }> }} Unit */

/**
 * @param {string} from
 * @param {string} specifier
 */
function resolveModule(from, specifier) {
	const base = path.resolve(path.dirname(from), specifier);
	return EXTENSIONS.map((ext) => `${base}${ext}`).find((at) =>
		fs.statSync(at, { throwIfNoEntry: false })?.isFile(),
	);
}

/**
 * @param {string} at
 * @param {string} code
 * @returns {Unit}
 */
function toUnit(at, code) {
	/** @type {Unit["bindings"]} */
	const bindings = new Map();
	for (const m of IMPORTS.flatMap((re) => [...code.matchAll(re)])) {
		const [, binding = "", , specifier = ""] = m;
		const target = resolveModule(at, specifier);
		if (!target) continue;
		if (!binding.startsWith("{")) {
			bindings.set(binding.replace(/^\*\s*as\s+/, ""), {
				at: target,
				name: null,
			});
			continue;
		}
		for (const part of binding.slice(1, -1).split(",")) {
			const [name, local = name] = part
				.trim()
				.split(/:|\bas\b/)
				.map((s) => s.trim());
			if (name && local) bindings.set(local, { at: target, name });
		}
	}
	return { lines: code.split("\n"), bindings };
}

/**
 * @param {string[]} lines
 * @param {string} name
 * @returns {string[] | null}
 */
function definitionBody(lines, name) {
	if (KEYWORDS.has(name)) return null;
	const n = escapeRe(name);
	const definition = new RegExp(
		[
			`\\bfunction\\s+${n}\\s*\\(`,
			`\\b(?:const|let|var)\\s+${n}\\s*=`,
			`\\b(?:module\\.)?exports\\.${n}\\s*=`,
			`^\\s*(?:static\\s+)?(?:async\\s+)?${n}\\s*\\([^)]*\\)\\s*\\{`,
			`^\\s*${n}\\s*:\\s*(?:async\\b|function\\b|\\(|${IDENT}\\s*=>)`,
		].join("|"),
	);
	const start = lines.findIndex((l) => definition.test(l));
	if (start === -1) return null;
	let depth = 0;
	const body = [];
	for (const line of lines.slice(start, start + BODY_CAP)) {
		body.push(line);
		const bare = line.replace(LITERAL, '""');
		depth += (bare.match(/[{(]/g) ?? []).length;
		depth -= (bare.match(/[})]/g) ?? []).length;
		if (depth <= 0 && /[;},]\s*$/.test(bare)) break;
	}
	return body;
}

/** @param {Program} program */
function scanner({ at, code }) {
	/** @type {Map<string, Unit | null>} */
	const units = new Map([[at, toUnit(at, code)]]);
	/** @param {string} file */
	const unitAt = (file) => {
		if (!units.has(file)) {
			const text = dataOrThrow(readText(file));
			units.set(file, text === null ? null : toUnit(file, blankComments(text)));
		}
		return units.get(file) ?? null;
	};

	/**
	 * @param {string} file
	 * @param {string} callee
	 * @returns {{ file: string, body: string[] } | null}
	 */
	function definition(file, callee) {
		const unit = unitAt(file);
		if (!unit) return null;
		const dot = callee.lastIndexOf(".");
		const owner = callee.slice(0, Math.max(dot, 0));
		const name = callee.slice(dot + 1);
		const bound = unit.bindings.get(owner || name);
		const home =
			bound && !SELF.has(owner) && (owner ? bound.name === null : true)
				? bound
				: null;
		const where = home?.at ?? file;
		const lines = unitAt(where)?.lines;
		const body = lines && definitionBody(lines, home?.name ?? name);
		return body ? { file: where, body } : null;
	}

	/**
	 * @param {string} file
	 * @param {string} callee
	 * @param {number} hops
	 * @returns {boolean}
	 */
	function parses(file, callee, hops) {
		const found = definition(file, callee);
		if (!found) return false;
		const text = found.body.join("\n");
		if (PARSE.test(text)) return true;
		if (hops === 0) return false;
		const name = callee.slice(callee.lastIndexOf(".") + 1);
		return [...text.matchAll(CALL)]
			.map((m) => m[1] ?? "")
			.filter((c) => c !== callee && c !== name)
			.some((c) => parses(found.file, c, hops - 1));
	}

	/** @param {string[]} nearby */
	return (nearby) =>
		nearby.some(
			(l) =>
				PARSE.test(l) ||
				[...l.matchAll(MAPPED)].some((m) =>
					parses(at, m[1] ?? m[2] ?? "", HOPS),
				),
		);
}

/** @type {import("./lib/check").CheckSpec} */
const SPEC = heresySpec({
	name: "jsonl-reads",
	skip: [READER],
	breaches: [
		{
			tag: "JSONL-READ",
			sites: (program) => {
				const parseNear = scanner(program);
				return parseLineSites(
					program,
					(line, i, lines) =>
						NEWLINE_SPLIT.test(line) &&
						parseNear(lines.slice(i, i + WINDOW + 1)),
					EXEMPT,
				);
			},
			message: (rel, site) =>
				`${rel}:${site.line} hand-parses JSONL (\`${site.text}\`). Fix: ${FIX}`,
		},
	],
	summary: { phrase: "hand-parse JSONL", fix: FIX },
	finish(_ctx, scanned) {
		return {
			okLine: `${scanned} program(s), no hand-parsed JSONL.`,
			noun: "hand-parsed JSONL read(s)",
		};
	},
});

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
