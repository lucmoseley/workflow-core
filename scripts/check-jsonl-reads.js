#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { runCheck } = require("./lib/check");
const { exemptHint, exemptMarker } = require("./lib/exempt-markers.js");
const { dataOrThrow, readText } = require("./lib/file-read.js");
const { parseLineSites, heresySpec } = require("./lib/heresy-scan.js");
const { relativeUnder } = require("./lib/is-under.js");
const { escapeRe } = require("./lib/regex-group.js");
const { blankComments } = require("./lib/strip-comments.js");

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
const CALL = new RegExp(`(?<![\\w$.])(${CALLEE})\\s*\\(([^)]*)`, "g");
const SPECIFIER = `(["'])(\\.{1,2}/[^"']+)\\2`;
const IMPORTS = [
	new RegExp(
		`\\b(?:const|let|var)\\s+(\\{[^}]*\\}|${IDENT})\\s*=\\s*require\\(\\s*${SPECIFIER}\\s*\\)(?:\\.(${IDENT}))?`,
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
const EXEMPT = exemptMarker("jsonl-read");
const READER = "scripts/lib/jsonl.js";

const FIX = `read it through readJsonl (a file), parseJsonl (text) or parseJsonlRow (one streamed line) in ${READER}, as scripts/lib/dispatch-ledger.js's readCountedRows does; or mark it ${exemptHint("jsonl-read")}, an issue saying the text is no JSONL (#3452).`;

/** @typedef {{ lines: string[], bindings: Map<string, { at: string, name: string | null }> }} Unit */
/** @typedef {{ file: string, body: string, params: string[] }} Definition */

/**
 * @param {string} root
 * @param {string} from
 * @param {string} specifier
 */
function resolveModule(root, from, specifier) {
	const base = path.resolve(path.dirname(from), specifier);
	return EXTENSIONS.map((ext) => `${base}${ext}`).find(
		(at) =>
			relativeUnder(root, at) !== null &&
			fs.statSync(at, { throwIfNoEntry: false })?.isFile(),
	);
}

/**
 * @param {string} root
 * @param {string} at
 * @param {string} code
 * @returns {Unit}
 */
function parseUnit(root, at, code) {
	/** @type {Unit["bindings"]} */
	const bindings = new Map();
	for (const m of IMPORTS.flatMap((re) => [...code.matchAll(re)])) {
		const [, binding = "", , specifier = "", member] = m;
		const target = resolveModule(root, at, specifier);
		if (!target) continue;
		if (!binding.startsWith("{")) {
			bindings.set(binding.replace(/^\*\s*as\s+/, ""), {
				at: target,
				name: member ?? null,
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
 * @returns {{ body: string, params: string[] }[]}
 */
function readDefinitions(lines, name) {
	if (KEYWORDS.has(name)) return [];
	const n = escapeRe(name);
	const head = `(?:async\\s+)?(?:function\\b\\s*(?:${IDENT})?\\s*)?`;
	const definition = new RegExp(
		[
			`\\bfunction\\s+${n}\\s*\\(`,
			`\\b(?:const|let|var)\\s+${n}\\s*=`,
			`\\b(?:module\\.)?exports\\.${n}\\s*=`,
			`^\\s*(?:static\\s+)?(?:async\\s+)?${n}\\s*\\(.*\\)\\s*\\{`,
			`^\\s*${n}\\s*:\\s*(?:async\\b|function\\b|\\(|${IDENT}\\s*=>)`,
		].join("|"),
	);
	const signature = new RegExp(
		`${n}\\s*(?:[=:]\\s*${head})?\\(([^)]*)\\)|${n}\\s*[=:]\\s*(?:async\\s+)?(${IDENT})\\s*=>`,
	);
	return lines.flatMap((line, start) => {
		if (!definition.test(line)) return [];
		let depth = 0;
		const body = [];
		for (const next of lines.slice(start, start + BODY_CAP)) {
			body.push(next);
			const bare = next.replace(LITERAL, '""');
			depth += (bare.match(/[{(]/g) ?? []).length;
			depth -= (bare.match(/[})]/g) ?? []).length;
			if (depth <= 0 && /[;},]\s*$/.test(bare)) break;
		}
		const sig = line.match(signature);
		const params = [
			...(sig?.[1] ?? sig?.[2] ?? "").matchAll(new RegExp(IDENT, "g")),
		].map((m) => m[0]);
		return [{ body: body.join("\n"), params }];
	});
}

/**
 * @param {import("./lib/heresy-scan.js").Program} program
 * @param {string} rel
 */
function buildParseNear({ code, root }, rel) {
	const at = path.join(root, rel);
	/** @type {Map<string, Unit | null>} */
	const units = new Map([[at, parseUnit(root, at, code)]]);
	/** @param {string} file */
	const readUnit = (file) => {
		if (!units.has(file)) {
			const text = dataOrThrow(readText(file));
			units.set(
				file,
				text === null ? null : parseUnit(root, file, blankComments(text)),
			);
		}
		return units.get(file) ?? null;
	};

	/**
	 * @param {string} file
	 * @param {string} callee
	 * @returns {Definition[]}
	 */
	function findDefinitions(file, callee) {
		const unit = readUnit(file);
		if (!unit) return [];
		const dot = callee.lastIndexOf(".");
		const owner = callee.slice(0, Math.max(dot, 0));
		const name = callee.slice(dot + 1);
		const bound = unit.bindings.get(owner || name);
		const imported = owner ? bound?.name === null : bound !== undefined;
		const declared = new RegExp(
			`\\b(?:(?:const|let|var)\\s+${escapeRe(owner)}\\s*=(?!\\s*(?:require|await)\\b)|class\\s+${escapeRe(owner)}\\b)`,
		);
		const local =
			!owner || SELF.has(owner) || unit.lines.some((l) => declared.test(l));
		if (!imported && !local) return [];
		const where = imported && bound ? bound.at : file;
		const lines = readUnit(where)?.lines ?? [];
		return readDefinitions(lines, (imported && bound?.name) || name).map(
			(d) => ({ file: where, ...d }),
		);
	}

	/**
	 * @param {string} file
	 * @param {string} callee
	 */
	const isParsingHelper = (file, callee) =>
		findDefinitions(file, callee).some(
			({ file: home, body, params }) =>
				PARSE.test(body) ||
				[...body.matchAll(CALL)].some(
					([, c = "", args = ""]) =>
						c !== callee &&
						params.some((p) => new RegExp(`\\b${escapeRe(p)}\\b`).test(args)) &&
						findDefinitions(home, c).some((d) => PARSE.test(d.body)),
				),
		);

	/** @param {string[]} nearby */
	return (nearby) =>
		nearby.some(
			(l) =>
				PARSE.test(l) ||
				[...l.matchAll(MAPPED)].some((m) =>
					isParsingHelper(at, m[1] ?? m[2] ?? ""),
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
			sites: (program, rel) => {
				const parseNear = buildParseNear(program, rel);
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
