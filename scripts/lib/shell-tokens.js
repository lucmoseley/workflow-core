/*
 * shell-tokens.js — one POSIX-shell lexing pass over a command (#3445), so a
 * classifier reads words, operators and redirects rather than regexing the
 * text.
 *
 * A word's quotes are removed and its backslash-newlines deleted. Where
 * bash and dash read a word differently it is read as bash does and marked
 * `bashOnly`, for a caller to refuse rather than trust (#3545): `$'…'` is
 * decoded, `$"…"` unquoted, and a comma brace expansion (`{a,b}`) makes a
 * word of each alternative. An expansion whose text is not known until the
 * shell runs it — a command, process or arithmetic substitution, a parameter,
 * a brace range — is kept as a null piece. Residual: a here-doc's body is
 * lexed as commands, and globs, tildes and `case` patterns are read
 * as literal text.
 */

const { requiredGroup } = require("./regex-group.js");

/**
 * @typedef {{type: "word", value: string, raw: string, quoted: boolean,
 *   bashOnly: boolean, pieces: (string|null)[], subs: Token[][]}} Word
 *   `value` is the literal text, quotes removed; `bashOnly` where it holds a
 *   construct dash reads otherwise; `pieces` that text split at each
 *   expansion, a null standing for one; `subs` each substitution's own
 *   tokens.
 * @typedef {{type: "op", value: string}} Op `&&`, `;`, a newline, a group's
 *   bracket or brace, and the like.
 * @typedef {{type: "redirect", op: string, target: Word|null}} Redirect
 * @typedef {Word|Op|Redirect} Token
 */

const BLANKS = " \t";
/* What ends an unquoted word. */
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
/* Past this many words, a brace expansion is kept as one null piece. A
 * guess, unmeasured: far above any brace expansion a check_staged command
 * writes, and low enough that a word of n braces, 2^n words, stays cheap to
 * lex. */
const MAX_BRACE_WORDS = 64;
const ANSI_C_ESCAPE =
	/\\(x[\dA-Fa-f]{1,2}|u[\dA-Fa-f]{1,4}|U[\dA-Fa-f]{1,8}|[0-7]{1,3}|c.|.)/gs;
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
	}),
);
/* What a backslash escapes inside double quotes. */
const DOUBLE_ESCAPES = '$`"\\\n';

/** @param {string} src @returns {Token[]} */
function tokenise(src) {
	return lexList(src, 0, false).tokens;
}

/** @param {string} src @param {number} i @param {string[]} list */
const startsAt = (src, i, list) => list.find((s) => src.startsWith(s, i));

/** Whether `src` has one of `chars` at `i`; past its end it has none.
 * @param {string} chars @param {string} src @param {number} i */
const isOneOf = (chars, src, i) => {
	const c = src[i];
	return c !== undefined && chars.includes(c);
};

/** @param {string} src @param {number} i */
const isMeta = (src, i) => i >= src.length || isOneOf(META, src, i);

/**
 * @param {string} src
 * @param {number} start
 * @param {boolean} inSub whether an unmatched `)` ends the list, as in `$(…)`
 * @returns {{tokens: Token[], end: number}} `end` is past that `)`
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

/** How far a token opens (1) or closes (-1) a subshell. @param {Token} t */
const bracketStep = (t) =>
	t.type === "op" ? Number(t.value === "(") - Number(t.value === ")") : 0;

/** Past a blank, a backslash-newline or a comment at `i`, or `i`.
 * @param {string} src @param {number} i */
function skip(src, i) {
	if (src.startsWith("\\\n", i)) return i + 2;
	if (isOneOf(BLANKS, src, i)) return i + 1;
	if (src[i] !== "#") return i;
	const nl = src.indexOf("\n", i);
	return nl < 0 ? src.length : nl;
}

/** The tokens at `i`, which is no blank: one, or a brace expansion's words.
 * @param {string} src @param {number} i
 * @returns {{tokens: Token[], end: number}} */
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
	/* A group's reserved words, standing alone. */
	if (raw === "{" || raw === "}")
		return { tokens: [{ type: "op", value: raw }], end };
	return { tokens: words, end };
}

class WordBuilder {
	constructor() {
		/** @type {(string|null|string[])[]} a brace expansion's alternatives
		 * as a list */
		this.pieces = [];
		/** @type {Token[][]} */
		this.subs = [];
		this.text = "";
		this.quoted = false;
		this.bashOnly = false;
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

	/** A quoted span's literal text. @param {string} span */
	span(span) {
		this.text += span;
		this.quoted = true;
	}
}

/**
 * Each part parser takes the source, the index of a part it recognises and
 * accumulator: the word being built, which it adds the part to; it returns
 * the index past the part, or undefined where the part is not its own.
 * @typedef {(src: string, i: number, w: WordBuilder) => number|undefined} PartParser
 */

/** @type {PartParser} */
const parseEscape = (src, i, w) => {
	if (src[i] !== "\\") return;
	if (src[i + 1] !== "\n") {
		w.text += src[i + 1] ?? "\\";
		w.quoted = true;
	}
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
	w.span(src.slice(i + 2, k).replace(ANSI_C_ESCAPE, decodeAnsiC));
	w.bashOnly = true;
	return k + 1;
};

/** One `$'…'` escape's text. @param {string} _ @param {string} esc */
function decodeAnsiC(_, esc) {
	if (/^[xuU]/.test(esc))
		return String.fromCodePoint(Number.parseInt(esc.slice(1), 16));
	if (/^[0-7]/.test(esc)) return String.fromCodePoint(Number.parseInt(esc, 8));
	if (esc[0] === "c")
		return String.fromCharCode((esc.codePointAt(1) ?? 0) & 31);
	return ANSI_C_LETTERS.get(esc) ?? esc;
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

/** One part inside double quotes; its end. @param {string} src
 * @param {number} k @param {WordBuilder} w accumulator: the word being built */
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

/** The end of the expansion at the `$` at `i`, or undefined for a literal
 * `$`. @type {PartParser} */
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

/** `<(…)` and `>(…)`. @type {PartParser} */
const parseProcess = (src, i, w) => {
	if (!isOneOf("<>", src, i) || src[i + 1] !== "(") return;
	const end = parseSub(src, i + 2, w);
	w.opaque();
	w.bashOnly = true;
	return end;
};

/** `{a,b}` and `{1..3}`; any other brace is literal. @type {PartParser} */
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
 * The word starting at `start`, as the words its brace expansions make;
 * `raw` its source text.
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
		if (end === undefined) w.text += src[i];
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
		pieces,
		subs: w.subs,
	}));
	/* The shell drops a brace expansion's empty unquoted word. */
	return {
		words: braced
			? words.filter((x) => x.value || x.quoted || isOpaque(x))
			: words,
		raw,
	};
}

/**
 * Each word's pieces a brace expansion's alternatives make, or one null piece
 * for each past MAX_BRACE_WORDS.
 * @param {(string|null|string[])[]} pieces
 * @returns {(string|null)[][]}
 */
function expandBraces(pieces) {
	/** @type {(string|null)[][]} */
	let words = [[]];
	for (const p of pieces) {
		const alternatives = Array.isArray(p) ? p : [p];
		words = words.flatMap((word) => alternatives.map((a) => [...word, a]));
	}
	return words.length > MAX_BRACE_WORDS
		? [pieces.map((p) => (Array.isArray(p) ? null : p))]
		: words;
}

/** The index of the next `ch` from `from` that no backslash escapes, or the
 * end. @param {string} src @param {number} from @param {string} ch */
function scanTo(src, from, ch) {
	let k = from;
	while (k < src.length && src[k] !== ch) k += src[k] === "\\" ? 2 : 1;
	return k;
}

/** A substitution's commands from `from` to its `)`, added to `w`; its end.
 * @param {string} src @param {number} from
 * @param {WordBuilder} w accumulator: the word being built */
function parseSub(src, from, w) {
	const sub = lexList(src, from, true);
	w.subs.push(sub.tokens);
	return sub.end;
}

/**
 * The end of a `$((…))` whose body starts at `from`, or undefined where its
 * first `(` closes before its last, so it is a command substitution holding
 * a subshell, as the shell reads it.
 * @param {string} src @param {number} from
 */
function arithmeticEnd(src, from) {
	const end = closing(src, from, "()", 2);
	return closing(src, from, "()", 1) === end - 1 ? end : undefined;
}

/**
 * The end of a bracketed span whose `depth` openers precede `from`.
 * @param {string} src @param {number} from
 * @param {string} pair its opener then its closer @param {number} depth
 */
function closing(src, from, pair, depth) {
	let k = from;
	for (let d = depth; k < src.length && d > 0; k++) {
		if (src[k] === pair[0]) d++;
		else if (src[k] === pair[1]) d--;
	}
	return k;
}

/** Whether a word holds an expansion. @param {Word} word */
const isOpaque = (word) => word.pieces.includes(null);

module.exports = { tokenise, isOpaque };
