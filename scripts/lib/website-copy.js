/*
 * website-copy.js — the lexical half of the brand sheet's §11 banned-tells
 * list, and the extraction that decides what counts as website copy (mantahostels#858).
 *
 * Two jobs, kept apart because they fail differently: extractCopy() decides
 * WHERE copy lives in a source file, and TELLS decides WHAT is banned in it. A
 * false positive is almost always the first; a missed tell is almost always the
 * second.
 *
 * WHAT COUNTS AS COPY. String literals and JSX text, minus the literals that
 * are plainly not prose: import specifiers, and the values of attributes that
 * carry identifiers rather than words (className, href, id, …). Comments are
 * not copy — §11 binds what a reader sees, and a source comment is repo prose,
 * which keeps its em dash.
 *
 * Deliberately NOT scanned, though §11 bans them — its items 6 to 9 (false
 * ranges, synonym cycling, boldface overuse, title-case headings) and item 14
 * (false agency), plus the noun/verb-ambiguous half of item 2's copula tell
 * ("features", a legitimate noun on a hostel page). False ranges is the one
 * that looks scannable and is not: its only lexical shape, "from X to Y", is
 * what a place blurb says about geography ("from Berawa up to Echo Beach"), so
 * a pattern would fire mostly on correct copy. False agency is the same
 * problem in the other direction — the pattern is a subject/verb pairing, not
 * a string. Each needs a judgement a regex cannot make, and they are read by
 * eye.
 *
 * KNOWN MISSES, all silent, all false negatives: a tell straddling a template
 * interpolation or an inline JSX element is split across two segments and found
 * in neither; and an en dash is not banned, so it passes — §11 bans the em dash
 * by name and the en dash was not put in its place.
 *
 * FOUR MORE, each the price of a false positive refused, and each argued at its
 * own tell below (mantahostels#2812).
 *
 * The extractor is a scanner, not a TypeScript parser: it tracks quotes,
 * template interpolation and comments, then reads JSX text as whatever sits
 * between a `>` and the next `<` in what is left. That last heuristic also
 * catches fragments of generic type syntax, which is harmless — no tell here
 * matches an identifier — but it is why a new tell must be checked against real
 * code before it is added.
 */

const { requiredGroup } = require("./regex-group.js");

/** @typedef {{ text: string, index: number }} Segment A run of website copy. */
/** @typedef {{ tag: string, fix: string, match: string, line: number, context: string }} Hit */
/**
 * Template-literal nesting: each open backtick pushes a frame, and `${` inside
 * one pushes a brace depth that returns to the literal at 0.
 *
 * @typedef {{ start: number, braces: number }} TemplateFrame
 */
/** @typedef {{ source: string, segments: Segment[], residue: (string | undefined)[], stack: TemplateFrame[] }} Scan */

/** One banned tell: a tag, the pattern that finds it, and the fix to print. */
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
		/* Throat-clearing openers. Two stop-slop families next to this one are
		 * deliberately absent (mantahostels#2812): its blanket adverb ban and its Wh- sentence-
		 * starter ban both fire on ordinary short UI copy — /how-we-rank is a page
		 * titled with a Wh- phrase — so neither survives as a FAIL gate.
		 *
		 * "here's how" and stop-slop's "full stop." are absent for a second
		 * reason: §11 item 12 names neither, and a FAIL citing an item that does
		 * not carry the string is a gate the reader cannot act on. */
		pattern:
			/\b(here'?s (the thing|what|why)|it turns out|the (uncomfortable )?truth is|let me be clear|make no mistake|let that sink in)\b/giu,
	},
	{
		tag: "FILLER",
		fix: "Cut the phrase and state the point.",
		/* Filler phrases that announce a sentence without carrying one.
		 *
		 * "in today's X" is gated AT A SENTENCE START ONLY (mantahostels#2812): mid-sentence it
		 * is ordinary English — "check in today's guests" — and the cliche is
		 * always an opener. Segment start counts, `m` being unset. */
		pattern:
			/\b(when it comes to|at the end of the day|in a world where|it'?s worth noting|at its core|the reality is)\b|(?:^|[.!?]\s+)in today'?s\b/giu,
	},
	{
		tag: "FILLER",
		fix: "Say the plain word.",
		/* Business jargon. "Navigate" and "unpack" are excluded on false positives
		 * (mantahostels#2812): both are literal on a hostel page — navigating a booking,
		 * unpacking a bag.
		 *
		 * "double down" is gated only as "double down ON": bare "doubles down" is
		 * a room type and a corridor — "private doubles down the hall" — and the
		 * jargon almost always carries its object. §11 bans the bare phrase; this
		 * is the scanner being narrower than the sheet, not the sheet moving. */
		pattern:
			/\b(game[ -]?changer|deep dive|lean(s|ed|ing)? into|double(s|d)? down on|circle back|moving forward|on the same page|take a step back)\b/giu,
	},
	{
		tag: "TRAVEL-CLICHE",
		fix: "Say the specific thing about this place, or cut the sentence.",
		/* The register a generated place page drifts into, which neither stop-slop
		 * nor unslop carries — both are written for essays.
		 *
		 * "must-visit" takes the HYPHEN only: unhyphenated "must visit" is an
		 * ordinary obligation a system message writes ("guests must visit
		 * reception on arrival"), and the cliche is always the compound. §11 names
		 * that one compound, so "must-see" and "must-do" are not gated here. */
		pattern:
			/\b(nestled|bustling|vibrant|hidden gem|must-visits?|breathtaking|stunning|picturesque|charming|quaint|idyllic|home away from home|(in|at) the heart of|stone'?s throw)\b/giu,
	},
	{
		tag: "TRAVEL-CLICHE",
		fix: "Say the specific thing about this place, or cut the sentence.",
		/* THE ONE CASE-SENSITIVE TELL, and the reason it is split out (mantahostels#2812):
		 * capitalised, both words are hostel names — "Paradise Hostel" —
		 * and a generated place page carries a hostel name as a string literal,
		 * squarely inside this scanner's reach. Lowercase they are only ever the
		 * cliche §11 item 13 bans. */
		pattern: /\b(paradise|oasis)\b/gu,
	},
	{
		tag: "EMOJI",
		/* ©, ® and ™ are Extended_Pictographic and are excluded outright: a footer's
		 * copyright mark is never decoration. */
		fix: "No decorative emoji in product copy (§4). One carrying information in a badge or legend is exempt — say so in a comment and leave it.",
		pattern: /(?!©|®|™)\p{Extended_Pictographic}/gu,
	},
	{
		tag: "CURLY-QUOTE",
		fix: "Straight quotes and apostrophes throughout. In JSX, &apos; renders the straight apostrophe.",
		/* #821[6789] is the numeric-entity range, not a ticket cite — kept bare
		 * so a citation-rewriter doesn't recorrupt it into
		 * mantahostels#821[6789] again (#47). */
		pattern: /[‘’“”]|&(lsquo|rsquo|ldquo|rdquo|#821[6789]|#x201[89CD]);/giu,
	},
	{
		tag: "EM-DASH",
		fix: "A comma, a full stop or a colon does the job; · separates the halves of a metadata title. An en dash is not a substitute.",
		pattern: /—|&(mdash|#8212|#x2014);/giu,
	},
];

/* JSX/HTML attributes whose values are identifiers, paths or tokens rather than
 * prose. `content` is absent on purpose: a <meta content="…"> is copy.
 *
 * `=` only, never `:`. These names double as object keys carrying real copy, and
 * a `:` alternative silently dropped all of it. An object key that really is a
 * token is caught by isTokenShaped instead. */
const IDENTIFIER_ATTRS =
	/(?:^|[\s{(,])(?:className|class|href|src|srcSet|id|key|rel|as|type|role|slug|sizes|charSet|style|name|width|height|viewBox|fill|stroke|d|data-[\w-]+|aria-[\w-]+)\s*=\s*(?:\{\s*)?$/;

/* A module specifier: `from "…"`, `import "…"`, `import("…")`, `require("…")`.
 * Nearly every one is token-shaped and would be dropped anyway; this catches the
 * legal minority that are not, such as a stylesheet whose filename has a space. */
const SPECIFIER = /(?:\b(?:from|import)\s*(?:\(\s*)?|\brequire\s*\(\s*)$/;

/* A token rather than a sentence: no whitespace, nothing outside the
 * identifier/path/URL character set, and at least one character that a plain
 * English word would not carry — a digit, a hyphen, an underscore, a slash. A
 * lone alphabetic word stays copy, because "Tapestry" as a one-word label is a
 * tell and "clean" is not a class name; a curly quote or an em dash is outside
 * the set entirely, so a one-word string carrying one is copy too. */
const TOKEN_CHARS = /^[\w@/.\-#:$?&=+%~[\]]*$/;
const NOT_A_WORD = /[^A-Za-z]/;
const isTokenShaped = (/** @type {string} */ text) =>
	!/\s/.test(text) && NOT_A_WORD.test(text) && TOKEN_CHARS.test(text);

/**
 * The copy segments of one source file, in source order.
 *
 * Returns `{ text, index }` — the segment and its offset in `source`, so a
 * caller can turn an offset into a line number once for the whole file.
 *
 * @param {string} source
 * @returns {Segment[]}
 */
function extractCopy(source) {
	/** @type {Scan} */
	const scan = {
		source,
		segments: [],
		/* The source with every comment and string body blanked to spaces, so
		 * pushJsxText reads code positions that still line up with `source`. */
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
 * Reads the character at `i` and returns the index to read next.
 *
 * @param {Scan} scan accumulator: the walk's state, advanced one step
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
 * Where a comment or regex literal opening at `i` ends, or -1 when none opens
 * there.
 *
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
 * A regex literal, not division. Its body is neither code nor copy, and left
 * unread a `/"/` swallows the next real string whole.
 *
 * @param {string} source
 * @param {number} i index of the opening `/`
 * @returns {number} the index after the closing `/`
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
 * @param {Scan} scan accumulator: the literal's segment, or its quote's residue, is added
 * @param {number} i index of the opening quote
 * @returns {number}
 */
function readQuoted(scan, i) {
	const end = closingQuote(scan.source, i);
	/* No closing quote before the line ends means this was never a string: an
	 * apostrophe in JSX text ("don't miss it") is the common case, and reading
	 * it as one runs a literal to EOF and corrupts every line number after it.
	 * Treat the character as ordinary code and move on. */
	if (end === -1) {
		scan.residue[i] = scan.source[i];
		return i + 1;
	}
	pushLiteral(scan.segments, scan.source, i + 1, end);
	return end + 1;
}

/**
 * @param {Scan} scan accumulator: the closed literal's segment is added, and its frame popped or a new one pushed
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
 * @param {Scan} scan accumulator: the literal's segment is added where an interpolation opens
 * @param {number} i
 * @param {TemplateFrame} top accumulator: the literal being read, its braces opened at an interpolation
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
 * Inside `${ … }`: ordinary code, so track braces and hand the tail of the
 * literal back when the interpolation closes.
 *
 * @param {TemplateFrame} top accumulator: its brace depth tracked, and its start moved on when the interpolation closes
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
 * JSX text: whatever sits between a `>` and the next `<` in the residue.
 *
 * @param {Segment[]} segments accumulator: each JSX text run is pushed here
 * @param {string} code
 */
function pushJsxText(segments, code) {
	const jsx = /(?<=>)([^<>]+)(?=<)/g;
	let m = jsx.exec(code);
	while (m !== null) {
		/* Braces left behind by a stripped JSX expression or comment are not text. */
		const text = requiredGroup(m, 1, jsx);
		if (!/^[{}\s]*$/.test(text)) segments.push({ text, index: m.index });
		m = jsx.exec(code);
	}
}

/**
 * Where the string opened at `at` closes, or -1 if it does not close on its own
 * line. A JavaScript string literal cannot span a raw newline, so a newline is
 * proof this quote opened no string.
 *
 * @param {string} source
 * @param {number} at index of the opening quote
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

/* What can precede a regex literal but never a division: an operator, an opening
 * bracket, a comma, a keyword. After a value — an identifier, a number, a
 * closing bracket — a `/` is division.
 *
 * `<` and `>` are deliberately absent, though both are operators: `</p>` would
 * otherwise read as a regex opening and swallow the rest of the line, and JSX
 * closing tags are far commoner here than `a < /re/.test(b)`. */
const BEFORE_REGEX =
	/(?:[=(,:;!&|?{}[+\-*%~^]|\b(?:return|typeof|case|in|of|do|else|yield|await|new|delete|void|throw))\s*$/;

/**
 * Whether the `/` at `at` opens a regex literal rather than a division.
 *
 * @param {string} source
 * @param {number} at
 */
function startsRegex(source, at) {
	const before = source.slice(Math.max(0, at - 40), at);
	return before.trim() === "" || BEFORE_REGEX.test(before);
}

/**
 * A string literal, unless its position or shape says it is not prose.
 *
 * @param {Segment[]} segments accumulator: the literal is pushed here unless it is not prose
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
 * Every banned tell in one source file.
 *
 * Returns `{ tag, fix, match, line }`, one per hit, in source order. `line` is
 * 1-based, so it can be printed straight into a `path:line` reference.
 *
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
 * An offset-to-line-number lookup for one source, built once.
 *
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
			// lo < mid <= hi, and hi starts at the last index.
			if (start === undefined)
				throw new Error(`line index ${mid} is past the last line start`);
			if (start <= offset) lo = mid;
			else hi = mid - 1;
		}
		return lo + 1;
	};
}

/**
 * Enough of the copy around a hit to recognise it without opening the file.
 *
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
