const { requiredGroup } = require("./regex-group.js");

/** @typedef {{ text: string, index: number }} Segment */
/** @typedef {{ tag: string, fix: string, match: string, line: number, context: string }} Hit */
/** @typedef {{ start: number, braces: number }} TemplateFrame */
/** @typedef {{ source: string, segments: Segment[], residue: (string | undefined)[], stack: TemplateFrame[] }} Scan */

const TELLS = [
	{
		tag: "AI-VOCAB",
		fix: "Say the plain word, or cut the sentence that needed it.",
		pattern:
			/\b(delv(e|es|ed|ing)|crucial|tapestry|testament|underscor(e|es|ed|ing)|showcas(e|es|ed|ing)|garner(s|ed|ing)?|pivotal|intricate|interplay|landscapes?)\b/giu,
	},
	{
		tag: "COPULA",
		fix: 'Write "is" and "has".',
		pattern: /\b(serv(es|ing) as|stand(s|ing) as|boast(s|ed|ing)?)\b/giu,
	},
	{
		tag: "ING-TAIL",
		fix: "Cut the clause, or make it its own sentence with a subject.",
		pattern:
			/,\s+(highlighting|showcasing|ensuring|underscoring|emphasi[sz]ing|reflecting|solidifying|cementing)\b/giu,
	},
	{
		tag: "NEG-PARALLEL",
		fix: "State the second half and stop.",
		pattern:
			/\b(not (just|only|merely)\b[^.?!]{1,60}?,\s*(it'?s|its|they'?re|but)\b|is(n'?t| not) about\b[^.?!]{1,60}?,\s*it'?s about\b)/giu,
	},
	{
		tag: "VAGUE-ATTRIBUTION",
		fix: "Name the source, or drop the claim.",
		pattern:
			/\b(experts? (believe|say|agree|suggest)|studies show|research (suggests|shows)|industry reports? (suggest|show)|it is widely (believed|known)|many believe)\b/giu,
	},
	{
		tag: "FILLER",
		fix: "Cut the phrase and state the point.",
		pattern:
			/\b(here'?s (the thing|what|why)|it turns out|the (uncomfortable )?truth is|let me be clear|make no mistake|let that sink in)\b/giu,
	},
	// lucmoseley/mantahostels#2812
	{
		tag: "FILLER",
		fix: "Cut the phrase and state the point.",
		pattern:
			/\b(when it comes to|at the end of the day|in a world where|it'?s worth noting|at its core|the reality is)\b|(?:^|[.!?]\s+)in today'?s\b/giu,
	},
	// lucmoseley/mantahostels#2812
	{
		tag: "FILLER",
		fix: "Say the plain word.",
		pattern:
			/\b(game[ -]?changer|deep dive|lean(s|ed|ing)? into|double(s|d)? down on|circle back|moving forward|on the same page|take a step back)\b/giu,
	},
	// lucmoseley/mantahostels#2812
	{
		tag: "TRAVEL-CLICHE",
		fix: "Say the specific thing about this place, or cut the sentence.",
		pattern:
			/\b(nestled|bustling|vibrant|hidden gem|must-visits?|breathtaking|stunning|picturesque|charming|quaint|idyllic|home away from home|(in|at) the heart of|stone'?s throw)\b/giu,
	},
	// lucmoseley/mantahostels#2812
	{
		tag: "TRAVEL-CLICHE",
		fix: "Say the specific thing about this place, or cut the sentence.",
		pattern: /\b(paradise|oasis)\b/gu,
	},
	{
		tag: "EMOJI",
		fix: "No decorative emoji in product copy (§4). One carrying information in a badge or legend is exempt — say so in a comment and leave it.",
		pattern: /(?!©|®|™)\p{Extended_Pictographic}/gu,
	},
	// workflow-core#47
	{
		tag: "CURLY-QUOTE",
		fix: "Straight quotes and apostrophes throughout. In JSX, &apos; renders the straight apostrophe.",
		pattern: /[‘’“”]|&(lsquo|rsquo|ldquo|rdquo|#(?:821[6789]|x201[89CD]));/giu,
	},
	// workflow-core#47
	{
		tag: "EM-DASH",
		fix: "A comma, a full stop or a colon does the job; · separates the halves of a metadata title. An en dash is not a substitute.",
		pattern: /—|&(mdash|#(?:8212|x2014));/giu,
	},
];

const IDENTIFIER_ATTRS =
	/(?:^|[\s{(,])(?:className|class|href|src|srcSet|id|key|rel|as|type|role|slug|sizes|charSet|style|name|width|height|viewBox|fill|stroke|d|data-[\w-]+|aria-[\w-]+)\s*=\s*(?:\{\s*)?$/;

const SPECIFIER = /(?:\b(?:from|import)\s*(?:\(\s*)?|\brequire\s*\(\s*)$/;

const TOKEN_CHARS = /^[\w@/.\-#:$?&=+%~[\]]*$/;
const NOT_A_WORD = /[^A-Za-z]/;
const isTokenShaped = (/** @type {string} */ text) =>
	!/\s/.test(text) && NOT_A_WORD.test(text) && TOKEN_CHARS.test(text);

/**
 * @param {string} source
 * @returns {Segment[]}
 */
function extractCopy(source) {
	/** @type {Scan} */
	const scan = {
		source,
		segments: [],
		residue: new Array(source.length).fill(" "),
		stack: [],
	};

	let i = 0;
	while (i < source.length) i = scanStep(scan, i);

	pushJsxText(scan.segments, scan.residue.join(""));
	scan.segments.sort((a, b) => a.index - b.index);
	return scan.segments;
}

/**
 * @param {Scan} scan
 * @param {number} i
 * @returns {number}
 */
function scanStep(scan, i) {
	const { source } = scan;
	const c = source[i];
	const top = scan.stack.at(-1);
	const inTemplate = top !== undefined && top.braces === 0;

	if (!inTemplate) {
		const skipped = skipCommentOrRegex(source, i);
		if (skipped !== -1) return skipped;
		if (c === '"' || c === "'") return readQuoted(scan, i);
	}
	if (c === "`") return toggleTemplate(scan, i, top);
	if (inTemplate) return stepInTemplate(scan, i, top);
	if (top !== undefined) trackInterpolationBrace(top, c, i);
	scan.residue[i] = source[i];
	return i + 1;
}

/**
 * @param {string} source
 * @param {number} i
 * @returns {number}
 */
function skipCommentOrRegex(source, i) {
	if (source[i] !== "/") return -1;
	const next = source[i + 1];
	if (next === "/") {
		while (i < source.length && source[i] !== "\n") i++;
		return i;
	}
	if (next === "*") {
		i += 2;
		while (i < source.length && !(source[i] === "*" && source[i + 1] === "/"))
			i++;
		return i + 2;
	}
	if (startsRegex(source, i)) return regexEnd(source, i);
	return -1;
}

/**
 * @param {string} source
 * @param {number} i
 * @returns {number}
 */
function regexEnd(source, i) {
	i++;
	let inClass = false;
	while (i < source.length && source[i] !== "\n") {
		if (source[i] === "\\") {
			i += 2;
			continue;
		}
		if (source[i] === "/" && !inClass) break;
		if (source[i] === "[") inClass = true;
		else if (source[i] === "]") inClass = false;
		i++;
	}
	return i + 1;
}

/**
 * @param {Scan} scan
 * @param {number} i
 * @returns {number}
 */
function readQuoted(scan, i) {
	const end = closingQuote(scan.source, i);
	if (end === -1) {
		scan.residue[i] = scan.source[i];
		return i + 1;
	}
	pushLiteral(scan.segments, scan.source, i + 1, end);
	return end + 1;
}

/**
 * @param {Scan} scan
 * @param {number} i
 * @param {TemplateFrame | undefined} top
 * @returns {number}
 */
function toggleTemplate(scan, i, top) {
	if (top !== undefined && top.braces === 0) {
		pushLiteral(scan.segments, scan.source, top.start, i);
		scan.stack.pop();
	} else {
		scan.stack.push({ start: i + 1, braces: 0 });
	}
	return i + 1;
}

/**
 * @param {Scan} scan
 * @param {number} i
 * @param {TemplateFrame} top
 * @returns {number}
 */
function stepInTemplate(scan, i, top) {
	const c = scan.source[i];
	if (c === "\\") return i + 2;
	if (c === "$" && scan.source[i + 1] === "{") {
		pushLiteral(scan.segments, scan.source, top.start, i);
		top.braces = 1;
		return i + 2;
	}
	return i + 1;
}

/**
 * @param {TemplateFrame} top
 * @param {string | undefined} c
 * @param {number} i
 */
function trackInterpolationBrace(top, c, i) {
	if (c === "{") top.braces++;
	else if (c === "}") {
		top.braces--;
		if (top.braces === 0) top.start = i + 1;
	}
}

/**
 * @param {Segment[]} segments
 * @param {string} code
 */
function pushJsxText(segments, code) {
	const jsx = /(?<=>)([^<>]+)(?=<)/g;
	let m = jsx.exec(code);
	while (m !== null) {
		const text = requiredGroup(m, 1, jsx);
		if (!/^[{}\s]*$/.test(text)) segments.push({ text, index: m.index });
		m = jsx.exec(code);
	}
}

/**
 * @param {string} source
 * @param {number} at
 * @returns {number}
 */
function closingQuote(source, at) {
	const quote = source[at];
	for (let j = at + 1; j < source.length; j++) {
		if (source[j] === "\\") j++;
		else if (source[j] === quote) return j;
		else if (source[j] === "\n") return -1;
	}
	return -1;
}

const BEFORE_REGEX =
	/(?:[=(,:;!&|?{}[+\-*%~^]|\b(?:return|typeof|case|in|of|do|else|yield|await|new|delete|void|throw))\s*$/;

/**
 * @param {string} source
 * @param {number} at
 */
function startsRegex(source, at) {
	const before = source.slice(Math.max(0, at - 40), at);
	return before.trim() === "" || BEFORE_REGEX.test(before);
}

/**
 * @param {Segment[]} segments
 * @param {string} source
 * @param {number} start
 * @param {number} end
 */
function pushLiteral(segments, source, start, end) {
	const text = source.slice(start, end);
	if (!text) return;
	if (isTokenShaped(text)) return;
	const before = source.slice(Math.max(0, start - 80), start - 1);
	if (SPECIFIER.test(before) || IDENTIFIER_ATTRS.test(before)) return;
	segments.push({ text, index: start });
}

/**
 * @param {string} source
 * @returns {Hit[]}
 */
function scanSource(source) {
	const lineOf = lineIndex(source);
	/** @type {Hit[]} */
	const hits = [];
	for (const seg of extractCopy(source)) {
		for (const tell of TELLS) {
			for (const m of seg.text.matchAll(tell.pattern)) {
				hits.push({
					tag: tell.tag,
					fix: tell.fix,
					match: m[0],
					line: lineOf(seg.index + m.index),
					context: context(seg.text, m.index, m[0].length),
				});
			}
		}
	}
	hits.sort((a, b) => a.line - b.line || a.tag.localeCompare(b.tag));
	return hits;
}

/**
 * @param {string} source
 * @returns {(offset: number) => number}
 */
function lineIndex(source) {
	const starts = [0];
	for (let i = 0; i < source.length; i++)
		if (source[i] === "\n") starts.push(i + 1);
	return (/** @type {number} */ offset) => {
		let lo = 0;
		let hi = starts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			const start = starts[mid];
			if (start === undefined)
				throw new Error(`line index ${mid} is past the last line start`);
			if (start <= offset) lo = mid;
			else hi = mid - 1;
		}
		return lo + 1;
	};
}

/**
 * @param {string} text
 * @param {number} at
 * @param {number} length
 */
function context(text, at, length) {
	const from = Math.max(0, at - 30);
	const to = Math.min(text.length, at + length + 30);
	return `${from > 0 ? "…" : ""}${text.slice(from, to).replace(/\s+/g, " ").trim()}${to < text.length ? "…" : ""}`;
}

module.exports = { scanSource };
