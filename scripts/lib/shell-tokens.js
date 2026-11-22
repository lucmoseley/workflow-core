const { requiredGroup } = require("./regex-group.js");

/**
 * @typedef {{type: "word", value: string, raw: string, quoted: boolean,
 *   bashOnly: boolean, glob: boolean, pieces: (string|null)[], subs:
 *   Token[][]}} Word
 * @typedef {{type: "op", value: string}} Op
 * @typedef {{type: "redirect", op: string, target: Word|null}} Redirect
 * @typedef {Word|Op|Redirect} Token
 */

const BLANKS = " \t";
const META = " \t\n;&|<>()";
const OPS = ["&&", "||", ";;", "|&", ";", "|", "&", "(", ")", "\n"];
const REDIRECTS = [
	"&>>",
	"&>",
	"<<<",
	"<<-",
	"<<",
	"<>",
	"<&",
	">&",
	">>",
	">|",
	"<",
	">",
];
const FD = /\d+(?=[<>])/y;
const NAME = /[A-Za-z_]\w*/y;
const SPECIAL_PARAMS = "0123456789@*#?!$-";
const BRACE_EXPANSION = /\{([^\s{}]*)\}/y;
// #4088 guess
const MAX_BRACE_WORDS = 64;
const ANSI_C_ESCAPE =
	/\\(x\{[\dA-Fa-f]*\}?|x[\dA-Fa-f]{1,2}|u[\dA-Fa-f]{1,4}|U[\dA-Fa-f]{1,8}|[0-7]{1,3}|c\\\\|c.|.)/gs;
const ANSI_C_LETTERS = new Map(
	Object.entries({
		a: "\x07",
		b: "\b",
		e: "\x1b",
		E: "\x1b",
		f: "\f",
		n: "\n",
		r: "\r",
		t: "\t",
		v: "\v",
		"\\": "\\",
		"'": "'",
		'"': '"',
		"?": "?",
	}),
);
const DOUBLE_ESCAPES = '$`"\\\n';

/** @param {string} src @returns {Token[]} */
function tokenise(src) {
	return lexList(src, 0, false).tokens;
}

/** @param {string} src @param {number} i @param {string[]} list */
const startsAt = (src, i, list) => list.find((s) => src.startsWith(s, i));

/** @param {string} chars @param {string} src @param {number} i */
const isOneOf = (chars, src, i) => {
	const c = src[i];
	return c !== undefined && chars.includes(c);
};

/** @param {string} src @param {number} i */
const isMeta = (src, i) => i >= src.length || isOneOf(META, src, i);

/**
 * @param {string} src
 * @param {number} start
 * @param {boolean} inSub
 * @returns {{tokens: Token[], end: number}}
 */
function lexList(src, start, inSub) {
	/** @type {Token[]} */
	const tokens = [];
	let i = start;
	let depth = 0;
	while (i < src.length) {
		const skipped = skip(src, i);
		if (skipped > i) {
			i = skipped;
			continue;
		}
		if (src[i] === ")" && inSub && depth === 0) return { tokens, end: i + 1 };
		const lexed = lexToken(src, i);
		tokens.push(...lexed.tokens);
		depth += lexed.tokens.reduce((d, t) => d + bracketStep(t), 0);
		i = lexed.end;
	}
	return { tokens, end: i };
}

/** @param {Token} t */
const bracketStep = (t) =>
	t.type === "op" ? Number(t.value === "(") - Number(t.value === ")") : 0;

/** @param {string} src @param {number} i */
function skip(src, i) {
	if (src.startsWith("\\\n", i)) return i + 2;
	if (isOneOf(BLANKS, src, i)) return i + 1;
	if (src[i] !== "#") return i;
	const nl = src.indexOf("\n", i);
	return nl < 0 ? src.length : nl;
}

/**
 * @param {string} src
 * @param {number} i
 * @returns {{tokens: Token[], end: number}}
 */
function lexToken(src, i) {
	FD.lastIndex = i;
	const at = i + (FD.exec(src)?.[0].length ?? 0);
	const redirect =
		src[at + 1] === "(" ? undefined : startsAt(src, at, REDIRECTS);
	if (redirect) {
		let k = at + redirect.length;
		while (isOneOf(BLANKS, src, k)) k++;
		const target = isMeta(src, k) ? undefined : parseWord(src, k);
		return {
			tokens: [
				{ type: "redirect", op: redirect, target: target?.words[0] ?? null },
			],
			end: k + (target?.raw.length ?? 0),
		};
	}
	const op = startsAt(src, i, OPS);
	if (op) return { tokens: [{ type: "op", value: op }], end: i + op.length };
	const { words, raw } = parseWord(src, i);
	const end = i + raw.length;
	if (raw === "{" || raw === "}")
		return { tokens: [{ type: "op", value: raw }], end };
	return { tokens: words, end };
}

class WordBuilder {
	constructor() {
		/** @type {(string|null|string[])[]} */
		this.pieces = [];
		/** @type {Token[][]} */
		this.subs = [];
		this.text = "";
		this.quoted = false;
		this.bashOnly = false;
		this.glob = false;
	}

	/** @param {string} c */
	plain(c) {
		this.glob ||=
			c === "*" || c === "?" || (c === "]" && this.text.includes("["));
		this.text += c;
	}

	opaque() {
		this.pieces.push(this.text, null);
		this.text = "";
	}

	/** @param {string[]} alternatives */
	brace(alternatives) {
		this.pieces.push(this.text, alternatives);
		this.text = "";
		this.bashOnly = true;
	}

	/** @param {string} span */
	span(span) {
		this.text += span;
		this.quoted = true;
	}
}

/**
 * @typedef {(src: string, i: number, w: WordBuilder) => number|undefined} PartParser
 */

/** @type {PartParser} */
const parseEscape = (src, i, w) => {
	if (src[i] !== "\\") return;
	if (src[i + 1] !== "\n") w.span(src[i + 1] ?? "\\");
	return i + 2;
};

/** @type {PartParser} */
const parseSingle = (src, i, w) => {
	if (src[i] !== "'") return;
	const close = src.indexOf("'", i + 1);
	const end = close < 0 ? src.length : close;
	w.span(src.slice(i + 1, end));
	return end + 1;
};

/** @type {PartParser} */
const parseAnsiC = (src, i, w) => {
	if (!src.startsWith("$'", i)) return;
	const k = scanTo(src, i + 2, "'");
	w.span(decodeAnsiC(src.slice(i + 2, k)));
	w.bashOnly = true;
	return k + 1;
};

/** @param {string} body */
function decodeAnsiC(body) {
	const bytes = Buffer.from(body)
		.toString("latin1")
		.replace(ANSI_C_ESCAPE, decodeAnsiCEscape);
	const nul = bytes.indexOf("\0");
	return Buffer.from(
		nul < 0 ? bytes : bytes.slice(0, nul),
		"latin1",
	).toString();
}

/** @param {string} _ @param {string} esc */
function decodeAnsiCEscape(_, esc) {
	if (/^x./s.test(esc)) {
		const digits = esc.replace(/[^\dA-Fa-f]/g, "");
		return String.fromCharCode(Number.parseInt(digits.slice(-2) || "0", 16));
	}
	if (/^[uU]./s.test(esc)) return encodeUtf8(Number.parseInt(esc.slice(1), 16));
	if (/^[0-7]/.test(esc))
		return String.fromCharCode(Number.parseInt(esc, 8) & 255);
	if (/^c./s.test(esc))
		return esc[1] === "?"
			? "\x7f"
			: String.fromCharCode(esc.charCodeAt(1) & 31);
	return ANSI_C_LETTERS.get(esc) ?? `\\${esc}`;
}

/** @param {number} codePoint */
function encodeUtf8(codePoint) {
	if (codePoint > 0x7f_ff_ff_ff) return "";
	if (codePoint < 0x80) return String.fromCharCode(codePoint);
	let bytes = "";
	let rest = codePoint;
	let leadMax = 0x3f;
	let lead = 0x80;
	while (rest > leadMax) {
		bytes = String.fromCharCode(0x80 | (rest & 0x3f)) + bytes;
		rest >>= 6;
		leadMax >>= 1;
		lead = (lead >> 1) | 0x80;
	}
	return String.fromCharCode(lead | rest) + bytes;
}

/** @type {PartParser} */
const parseDouble = (src, i, w) => {
	const open = startsAt(src, i, ['"', '$"']);
	if (!open) return;
	let k = i + open.length;
	while (k < src.length && src[k] !== '"') k = parseInDouble(src, k, w);
	w.quoted = true;
	w.bashOnly ||= open === '$"';
	return k + 1;
};

/** @param {string} src @param {number} k @param {WordBuilder} w */
function parseInDouble(src, k, w) {
	if (src[k] === "\\" && isOneOf(DOUBLE_ESCAPES, src, k + 1)) {
		if (src[k + 1] !== "\n") w.text += src[k + 1];
		return k + 2;
	}
	const end = parseBacktick(src, k, w) ?? parseDollar(src, k, w);
	if (end !== undefined) return end;
	w.text += src[k];
	return k + 1;
}

/** @type {PartParser} */
const parseDollar = (src, i, w) => {
	if (src[i] !== "$") return;
	const end = dollarEnd(src, i, w);
	if (end !== undefined) w.opaque();
	return end;
};

/** @type {PartParser} */
function dollarEnd(src, i, w) {
	const next = src[i + 1];
	const arithmetic = src.startsWith("$((", i)
		? arithmeticEnd(src, i + 3)
		: undefined;
	if (arithmetic !== undefined) return arithmetic;
	if (next === "(") return parseSub(src, i + 2, w);
	if (next === "{") return closing(src, i + 2, "{}", 1);
	NAME.lastIndex = i + 1;
	const name = NAME.exec(src);
	if (name) return i + 1 + name[0].length;
	return next !== undefined && SPECIAL_PARAMS.includes(next)
		? i + 2
		: undefined;
}

/** @type {PartParser} */
const parseBacktick = (src, i, w) => {
	if (src[i] !== "`") return;
	const k = scanTo(src, i + 1, "`");
	w.subs.push(tokenise(src.slice(i + 1, k).replace(/\\`/g, "`")));
	w.opaque();
	return k + 1;
};

/** @type {PartParser} */
const parseProcess = (src, i, w) => {
	if (!isOneOf("<>", src, i) || src[i + 1] !== "(") return;
	const end = parseSub(src, i + 2, w);
	w.opaque();
	w.bashOnly = true;
	return end;
};

/** @type {PartParser} */
const parseBrace = (src, i, w) => {
	BRACE_EXPANSION.lastIndex = i;
	const m = BRACE_EXPANSION.exec(src);
	if (!m) return;
	const inner = requiredGroup(m, 1, BRACE_EXPANSION);
	if (inner.includes(",")) w.brace(inner.split(","));
	else if (inner.includes("..")) {
		w.opaque();
		w.bashOnly = true;
	} else return;
	return i + m[0].length;
};

/** @type {PartParser[]} */
const PART_PARSERS = [
	parseEscape,
	parseSingle,
	parseAnsiC,
	parseDouble,
	parseDollar,
	parseBacktick,
	parseProcess,
	parseBrace,
];

/**
 * @param {string} src
 * @param {number} start
 * @returns {{words: Word[], raw: string}}
 */
function parseWord(src, start) {
	const w = new WordBuilder();
	let i = start;
	while (i < src.length) {
		let end;
		for (const parse of PART_PARSERS) {
			end = parse(src, i, w);
			if (end !== undefined) break;
		}
		if (end === undefined && isMeta(src, i)) break;
		if (end === undefined) w.plain(src.charAt(i));
		i = end ?? i + 1;
	}
	w.pieces.push(w.text);
	const raw = src.slice(start, Math.min(i, src.length));
	const braced = w.pieces.some(Array.isArray);
	const expanded = expandBraces(w.pieces);
	/** @type {Word[]} */
	const words = expanded.map((pieces) => ({
		type: "word",
		value: pieces.filter((p) => p !== null).join(""),
		raw,
		quoted: w.quoted,
		bashOnly: w.bashOnly,
		glob: w.glob,
		pieces,
		subs: w.subs,
	}));
	return {
		words: braced
			? words.filter((x) => x.value || x.quoted || isOpaque(x))
			: words,
		raw,
	};
}

/** @param {(string|null|string[])[]} pieces @returns {(string|null)[][]} */
function expandBraces(pieces) {
	/** @type {(string|null)[][]} */
	let words = [[]];
	for (const p of pieces) {
		const alternatives = Array.isArray(p) ? p : [p];
		if (words.length * alternatives.length > MAX_BRACE_WORDS)
			return [pieces.map((piece) => (Array.isArray(piece) ? null : piece))];
		words = words.flatMap((word) => alternatives.map((a) => [...word, a]));
	}
	return words;
}

/** @param {string} src @param {number} from @param {string} ch */
function scanTo(src, from, ch) {
	let k = from;
	while (k < src.length && src[k] !== ch) k += src[k] === "\\" ? 2 : 1;
	return k;
}

/** @param {string} src @param {number} from @param {WordBuilder} w */
function parseSub(src, from, w) {
	const sub = lexList(src, from, true);
	w.subs.push(sub.tokens);
	return sub.end;
}

/** @param {string} src @param {number} from */
function arithmeticEnd(src, from) {
	const end = closing(src, from, "()", 2);
	return closing(src, from, "()", 1) === end - 1 ? end : undefined;
}

/**
 * @param {string} src
 * @param {number} from
 * @param {string} pair
 * @param {number} depth
 */
function closing(src, from, pair, depth) {
	let k = from;
	for (let d = depth; k < src.length && d > 0; k++) {
		if (src[k] === pair[0]) d++;
		else if (src[k] === pair[1]) d--;
	}
	return k;
}

/** @param {Word} word */
const isOpaque = (word) => word.pieces.includes(null);

/** @param {Token[]} tokens */
function simpleCommands(tokens) {
	/** @type {Word[][]} */
	const commands = [];
	/** @type {Word[]} */
	let current = [];
	for (const t of tokens) {
		if (t.type === "word") current.push(t);
		else if (t.type === "op") {
			commands.push(current);
			current = [];
		}
	}
	commands.push(current);
	return commands.filter((c) => c.length > 0);
}

/** @param {Token} t */
const wordOf = (t) => (t.type === "redirect" ? t.target : t);

const FLAG_EQUALS = /^-[^=\s]*=/;

/** @param {Token[]} tokens @param {boolean} [quoted] @returns {Word[][]} */
function allCommands(tokens, quoted = true) {
	return simpleCommands(tokens).concat(
		tokens.flatMap((t) => {
			const word = wordOf(t);
			if (word?.type !== "word") return [];
			const read =
				quoted && word.quoted
					? [tokenise(word.value.replace(FLAG_EQUALS, ""))]
					: [];
			return [...word.subs, ...read].flatMap((sub) => allCommands(sub, quoted));
		}),
	);
}

/** @param {Token[]} tokens */
const writtenCommands = (tokens) => allCommands(tokens, false);

/** @param {Word} w */
const isUnreadWord = (w) => isOpaque(w) || w.bashOnly;

module.exports = {
	tokenise,
	isOpaque,
	isUnreadWord,
	simpleCommands,
	wordOf,
	allCommands,
	writtenCommands,
};
