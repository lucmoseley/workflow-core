const { CITATION_REPO, exemptMarker } = require("./exempt-markers.js");
const { requiredGroup } = require("./regex-group.js");

const JS_COMMENT_LINE = /^\s*(\/\/|\/?\*)/;
const JS_TS_FILE = /\.[cm]?[jt]sx?$/;
const HASH_COMMENT_LINE = /^\s*#/;
const BARE_CITATION = /(?<![\w$&{#])#(\d+)(?!\w)/g;
/** @param {number} n */
const bareCitationGrep = (n) => `(^|[^[:alnum:]_$&{#])#${n}([^[:alnum:]_]|$)`;
const QUOTE_OPEN = /"""|[`"“]/g;
const TRIPLE_QUOTE = /"""|'''/g;
const FENCE = /^\s*(```|~~~)/;
const HUSKY_HOOK = /^\.husky\/[^/.]+$/;
const EXEMPT = exemptMarker("bare-citation");
// measured ~95 issues a day, #5356
const CITATION_CEILING = 10_000;

/** @param {string} text */
const qualifySpan = (text) =>
	text.replace(BARE_CITATION, (whole, n) =>
		Number(n) > CITATION_CEILING ? whole : `${CITATION_REPO}#${n}`,
	);

const SYNTAX_PAREN_BEFORE = /[\w$=]/;

/**
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
 * @param {string} above
 * @param {(line: string) => boolean} citable
 */
const excused = (above, citable) => citable(above) && EXEMPT.test(above);

/**
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
			out = `${out.slice(0, c.index)}${CITATION_REPO}${out.slice(c.index)}`;
		}
	}
	return out;
}

/**
 * @param {string} line
 * @param {RegExpExecArray} m
 * @returns {number}
 */
function quotedEnd(line, m) {
	const close = line.indexOf(m[0] === "“" ? "”" : '"', m.index + 1);
	return close < 0 ? m.index + 1 : close + 1;
}

/**
 * @param {string} line
 * @param {boolean} inSpan
 * @returns {[string, boolean]}
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
 * @param {string} rel
 * @returns {((line: string) => boolean) | null}
 */
function buildCitableLineTest(rel) {
	if (/\.md$/.test(rel)) return () => true;
	if (JS_TS_FILE.test(rel)) return (line) => JS_COMMENT_LINE.test(line);
	if (/\.(sh|py)$/.test(rel) || HUSKY_HOOK.test(rel)) {
		return (line) => HASH_COMMENT_LINE.test(line);
	}
	return null;
}

/**
 * @param {string[]} lines
 * @returns {Set<number>}
 */
function parseTripleQuotedLines(lines) {
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
 * @returns {boolean}
 */
const hasCitableCode = (rel) =>
	JS_TS_FILE.test(rel) || /\.sh$/.test(rel) || HUSKY_HOOK.test(rel);

/**
 * @param {string} body
 * @param {string} rel
 * @returns {string}
 */
function qualifyCitations(body, rel) {
	const byLine = buildCitableLineTest(rel);
	if (!byLine) return body;
	const quoted = /\.py$/.test(rel)
		? parseTripleQuotedLines(body.split("\n"))
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
 * @param {string} body
 * @param {string} rel
 * @returns {{line: number, n: string}[]}
 */
function unbracketedCodeCitations(body, rel) {
	const citable = buildCitableLineTest(rel);
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
 * @param {string} body
 * @returns {string}
 */
function qualifyProse(body) {
	return qualifyLines(body, () => true, { fences: true, code: null });
}

/**
 * @param {string} body
 * @param {(line: string, i: number) => boolean} citable
 * @param {{fences: boolean, code: ((line: string, above: string) => string) | null}} how
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
		qualifyProse(require("./read-fd.js").readFdAll(0).toString("utf8")),
	);
}

module.exports = {
	bareCitationGrep,
	CITATION_CEILING,
	buildCitableLineTest,
	HASH_COMMENT_LINE,
	JS_COMMENT_LINE,
	JS_TS_FILE,
	qualifyCitations,
	qualifyProse,
	parseTripleQuotedLines,
	unbracketedCodeCitations,
};
