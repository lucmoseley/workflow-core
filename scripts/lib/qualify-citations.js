/*
 * qualify-citations.js — a core text's bare `#N` spelled `workflow-core#N`
 * (workflow-core#396), since in an adopter the same number is an unrelated issue of its own
 * tracker. Two callers: the release build (plugin-tree.js), over every shipped
 * `.md`, the comment lines of a shipped `.js`, `.ts`, `.sh`, `.py` or extensionless
 * `.husky/` hook, a `.py` file's triple-quoted lines (workflow-core#427), and the bracketed
 * citations on those files' code lines (`.py` excepted, workflow-core#435); and the
 * rule-text reader, over a core fragment it emits outside the core (workflow-core#416). The
 * core's own tree stays bare.
 *
 * A CODE LINE'S `#N` IS QUALIFIED ONLY INSIDE A `( … )` CLOSING ON THE SAME
 * LINE (workflow-core#431 ruling (A)): printed deny text cites that way, and an
 * illustrative example like `#22 (gloss)` is left true. A `(` glued to a word,
 * `$` or `=` opens a call, subshell or array, never prose, so it brackets
 * nothing. Every other `#N` on a code line ships bare, so
 * unbracketedCodeCitations() lists them for the release build to refuse. A
 * line whose previous line is a comment naming BARE_CITATION_OK is neither
 * rewritten nor refused.
 *
 * Left alone on a comment line or in `.md`: a fenced block (`.md` alone), a
 * `#N` inside a backtick or double-quoted span (a backtick span runs on to the
 * next line, up to a blank one; single quotes are apostrophes too often to
 * count; a `"""`, in any file, opens none, being a `.py` docstring's
 * (workflow-core#427)). Everywhere: one glued to a word, `$`, `{`, `&` or `#`
 * (`mantahostels#N`, `${#1}`), and one above CITATION_CEILING.
 * Residual: a bracket closing on a later line leaves its `#N` bare (the safe
 * way to fail, never a wrong rewrite); a bracketed `#N` that is data rather
 * than text (a `gh --search "(#14)"`) is rewritten too; a JS code line opening
 * with `*` is read as a comment. In `.py`, every triple-quoted string counts,
 * docstring or not, and so does code sharing a line with one; a triple quote
 * inside a single-quoted string or after a trailing `#` flips the state, so the
 * lines up to the next triple quote are read the other way round.
 *
 * Run as a CLI it qualifies stdin as prose — rule-text.sh's route, so the bash
 * twin needs no port of the span rules.
 */

const { requiredGroup } = require("./regex-group.js");

const JS_COMMENT_LINE = /^\s*(\/\/|\/?\*)/;
const JS_TS_FILE = /\.[cm]?[jt]sx?$/;
const HASH_COMMENT_LINE = /^\s*#/;
const BARE_CITATION = /(?<![\w$&{#])#(\d+)(?!\w)/g;
const QUOTE_OPEN = /"""|[`"“]/g;
const TRIPLE_QUOTE = /"""|'''/g;
const FENCE = /^\s*(```|~~~)/;
const HUSKY_HOOK = /^\.husky\/[^/.]+$/;
const BARE_CITATION_OK = "bare-citation-ok";
/*
 * No core issue is numbered above this, so a higher `#N` is another tracker's
 * (`claude-code #82259`) or no citation at all. citation-tracker.js's
 * BAND_MAX is this same number, imported. 5000 (workflow-core#726): the tracker stood at
 * workflow-core#728 on 30 Sep 2026, 13 days after workflow-core#1 — ~55 issues a day, ~100 a day over
 * the last two — so this is six to eleven weeks of headroom.
 * check-citation-ceiling.js fails once the tracker is within its margin.
 */
const CITATION_CEILING = 5000;

/** @param {string} text */
const qualifySpan = (text) =>
	text.replace(BARE_CITATION, (whole, n) =>
		Number(n) > CITATION_CEILING ? whole : `workflow-core#${n}`,
	);

const SYNTAX_PAREN_BEFORE = /[\w$=]/;

/**
 * The `[open, close]` index pairs of every prose `( … )` that closes on this
 * line.
 * @param {string} line
 * @returns {[number, number][]}
 */
function bracketPairs(line) {
	/** @type {{at: number, prose: boolean}[]} */
	const open = [];
	/** @type {[number, number][]} */
	const pairs = [];
	for (let i = 0; i < line.length; i++) {
		if (line[i] === "(") {
			open.push({ at: i, prose: !SYNTAX_PAREN_BEFORE.test(line[i - 1] ?? "") });
		} else if (line[i] === ")") {
			const o = open.pop();
			if (o?.prose) pairs.push([o.at, i]);
		}
	}
	return pairs;
}

/**
 * @param {string} above the line before a code line
 * @param {(line: string) => boolean} citable
 */
const excused = (above, citable) =>
	citable(above) && above.includes(BARE_CITATION_OK);

/**
 * A code line's citations, each marked by whether a same-line bracket holds it.
 * @param {string} line
 * @returns {{index: number, n: string, bracketed: boolean}[]}
 */
function codeCitations(line) {
	const pairs = bracketPairs(line);
	return [...line.matchAll(BARE_CITATION)]
		.filter((m) => Number(m[1]) <= CITATION_CEILING)
		.map((m) => {
			const index = m.index ?? 0;
			return {
				index,
				n: requiredGroup(m, 1, BARE_CITATION),
				bracketed: pairs.some(([a, b]) => a < index && index < b),
			};
		});
}

/** @param {string} line */
function qualifyCodeLine(line) {
	let out = line;
	for (const c of codeCitations(line).reverse()) {
		if (c.bracketed) {
			out = `${out.slice(0, c.index)}workflow-core${out.slice(c.index)}`;
		}
	}
	return out;
}

/**
 * The offset just past the double-quoted span `m` opens.
 * @param {string} line
 * @param {RegExpExecArray} m a match of QUOTE_OPEN on a double quote
 * @returns {number}
 */
function quotedEnd(line, m) {
	const close = line.indexOf(m[0] === "“" ? "”" : '"', m.index + 1);
	// A double quote left unclosed is prose, never a span.
	return close < 0 ? m.index + 1 : close + 1;
}

/**
 * @param {string} line
 * @param {boolean} inSpan whether a backtick span left open on the line
 *   before runs into this one
 * @returns {[string, boolean]} the line, and whether it leaves a span open
 */
function qualifyLine(line, inSpan) {
	let out = "";
	let i = 0;
	while (i < line.length) {
		if (inSpan) {
			const close = line.indexOf("`", i);
			if (close < 0) return [out + line.slice(i), true];
			out += line.slice(i, close + 1);
			i = close + 1;
			inSpan = false;
			continue;
		}
		QUOTE_OPEN.lastIndex = i;
		const m = QUOTE_OPEN.exec(line);
		if (!m) break;
		out += qualifySpan(line.slice(i, m.index));
		if (m[0] === '"""') {
			out += m[0];
			i = m.index + m[0].length;
			continue;
		}
		if (m[0] === "`") {
			out += "`";
			inSpan = true;
			i = m.index + 1;
			continue;
		}
		const end = quotedEnd(line, m);
		out += line.slice(m.index, end);
		i = end;
	}
	return [out + qualifySpan(line.slice(i)), inSpan];
}

/**
 * Which lines of a shipped file carry citations, by extension; null where
 * none are rewritten.
 * @param {string} rel
 * @returns {((line: string) => boolean) | null}
 */
function citableLines(rel) {
	if (/\.md$/.test(rel)) return () => true;
	if (JS_TS_FILE.test(rel)) return (line) => JS_COMMENT_LINE.test(line);
	if (/\.(sh|py)$/.test(rel) || HUSKY_HOOK.test(rel)) {
		return (line) => HASH_COMMENT_LINE.test(line);
	}
	return null;
}

/**
 * The indexes of the lines a `.py` triple-quoted string opens, runs through or
 * closes on. A whole-line `#` comment outside one is skipped, so a triple quote
 * in it opens nothing.
 * @param {string[]} lines
 * @returns {Set<number>}
 */
function tripleQuotedLines(lines) {
	/** @type {Set<number>} */
	const held = new Set();
	/** @type {string | null} */
	let open = null;
	lines.forEach((line, i) => {
		if (open) held.add(i);
		else if (HASH_COMMENT_LINE.test(line)) return;
		for (const [q] of line.matchAll(TRIPLE_QUOTE)) {
			if (!open) open = q;
			else if (q === open) open = null;
			else continue;
			held.add(i);
		}
	});
	return held;
}

/**
 * @param {string} rel
 * @returns {boolean} whether the file's code lines carry bracketed citations
 */
const hasCitableCode = (rel) =>
	JS_TS_FILE.test(rel) || /\.sh$/.test(rel) || HUSKY_HOOK.test(rel);

/**
 * @param {string} body a shipped file's text
 * @param {string} rel its repo-relative path
 * @returns {string}
 */
function qualifyCitations(body, rel) {
	const byLine = citableLines(rel);
	if (!byLine) return body;
	const quoted = /\.py$/.test(rel)
		? tripleQuotedLines(body.split("\n"))
		: new Set();
	/** @type {(line: string, i: number) => boolean} */
	const citable = (line, i) => byLine(line) || quoted.has(i);
	return qualifyLines(body, citable, {
		fences: /\.md$/.test(rel),
		code: hasCitableCode(rel)
			? (line, above) => (excused(above, byLine) ? line : qualifyCodeLine(line))
			: null,
	});
}

/**
 * Every bare `#N` a code line of a shipped file keeps.
 * @param {string} body
 * @param {string} rel
 * @returns {{line: number, n: string}[]} 1-based line numbers
 */
function unbracketedCodeCitations(body, rel) {
	const citable = citableLines(rel);
	if (!citable || !hasCitableCode(rel)) return [];
	const lines = body.split("\n");
	return lines.flatMap((line, i) => {
		if (citable(line) || excused(lines[i - 1] ?? "", citable)) return [];
		return codeCitations(line)
			.filter((c) => !c.bracketed)
			.map((c) => ({ line: i + 1, n: c.n }));
	});
}

/**
 * @param {string} body prose, every line of it citable — a rule fragment
 * @returns {string}
 */
function qualifyProse(body) {
	return qualifyLines(body, () => true, { fences: true, code: null });
}

/**
 * @param {string} body
 * @param {(line: string, i: number) => boolean} citable
 * @param {{fences: boolean, code: ((line: string, above: string) => string) | null}} how
 *   `fences`: whether a fence opens a block left alone — prose only, since in
 *   a script it could only ever be a code line; `code`: what a non-citable
 *   line becomes, given the line before it, left as it is without one
 * @returns {string}
 */
function qualifyLines(body, citable, { fences, code }) {
	let inSpan = false;
	let inFence = false;
	const lines = body.split("\n");
	return lines
		.map((line, i) => {
			const fence = fences && FENCE.test(line);
			if (fence) inFence = !inFence;
			if (inFence || fence || !citable(line, i) || !line.trim()) {
				inSpan = false;
				return code && !citable(line, i)
					? code(line, lines[i - 1] ?? "")
					: line;
			}
			const [text, stillInSpan] = qualifyLine(line, inSpan);
			inSpan = stillInSpan;
			return text;
		})
		.join("\n");
}

if (require.main === module) {
	process.stdout.write(
		qualifyProse(require("node:fs").readFileSync(0, "utf8")),
	);
}

module.exports = {
	BARE_CITATION_OK,
	CITATION_CEILING,
	citableLines,
	JS_COMMENT_LINE,
	JS_TS_FILE,
	qualifyCitations,
	qualifyProse,
	tripleQuotedLines,
	unbracketedCodeCitations,
};
