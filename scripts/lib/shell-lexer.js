/*
 * shell-lexer.js — the guard parser's quote lexer (#490, #510), its own module
 * so the parser and the #510 bound test reach one Lexer (#4134).
 *
 * A CORE: it does no I/O and never runs the text.
 */

const { QUOTED, SENTINEL_BYTE } = require("./shell-words.js");
const { endRun } = require("./trim-run.js");

/** `[[:space:]]`, without JavaScript's wider Unicode `\s`. */
const SPACE = " \t\n\v\f\r";

/**
 * Does a word start after text `s` — nothing before it, or whitespace or a
 * control operator? A span's closing sentinel byte is neither, so `"a"#b` is
 * one word.
 * @param {string} s
 */
const isWordStart = (s) => s === "" || `${SPACE};&|()`.includes(s.slice(-1));

/**
 * The first of `chars` in `text` at or after `from`, or -1.
 * @param {string} text
 * @param {string} chars
 * @param {number} from
 */
function indexOfAny(text, chars, from) {
	for (let j = from; j < text.length; j++)
		if (chars.includes(text.charAt(j))) return j;
	return -1;
}

/**
 * THE LEXER (#490, #510). One left-to-right state machine, as shell lexes,
 * that blanks each outermost quoted span and records its text. Every pass that
 * asks whether a quote is open asks it, so no two can disagree.
 *
 * RESUMABLE: `lex` consumes text and leaves its state behind, so the line join
 * feeds each line once.
 *
 * The first quote opens the span and the other kind is literal inside it; a
 * backslash outside `'…'` escapes the next character; `$'…'` takes backslash
 * escapes after an odd run of `$` only, `$$` being the shell's pid. Inside
 * `"…"`, a `$(` is read to its own close, so the quotes of the command inside
 * close nothing. Inside a `$(…)`, brackets nest, quotes open spans of their
 * own, and a heredoc's body runs from the end of its opener's line to its
 * terminator line. `case` patterns and `#` comments there are not read.
 *
 * `frames` is the stack of open frames, innermost last: S `'…'`, E `$'…'`, D
 * `"…"`, C `$(…)`, H a heredoc body inside a C. Each frame's slot in `depth`,
 * `term` and `dash` is its stack index: a C's bracket depth and the heredoc
 * its line has opened, an H's terminator.
 */
class Lexer {
	/** @param {string[]} spans shared with every lexer of one parse, so an index
	 * any of them writes reads back from one array */
	constructor(spans) {
		this.spans = spans;
		/** Outermost spans opened, never reset, so a caller can tell a new span
		 * from the one it already judged. */
		this.opens = 0;
	}

	frames = "";
	out = "";
	span = "";
	quote = "";
	prefix = "";
	escaped = false;
	inComment = false;
	heredocLine = "";
	/** @type {number[]} */
	depth = [];
	/** @type {string[]} */
	term = [];
	/** @type {string[]} */
	dash = [];

	reset() {
		this.load(new Lexer(this.spans).save());
	}

	/** The state set aside around a lex that must not move it on. */
	save() {
		const {
			frames,
			out,
			span,
			quote,
			prefix,
			escaped,
			inComment,
			heredocLine,
		} = this;
		return {
			frames,
			out,
			span,
			quote,
			prefix,
			escaped,
			inComment,
			heredocLine,
			depth: [...this.depth],
			term: [...this.term],
			dash: [...this.dash],
		};
	}

	/** @param {ReturnType<Lexer["save"]>} saved */
	load(saved) {
		Object.assign(this, {
			...saved,
			depth: [...saved.depth],
			term: [...saved.term],
			dash: [...saved.dash],
		});
	}

	/**
	 * @param {string} frame
	 * @param {string} [term]
	 * @param {string} [dash]
	 */
	push(frame, term = "", dash = "") {
		const n = this.frames.length;
		this.frames += frame;
		this.depth[n] = 1;
		this.term[n] = term;
		this.dash[n] = dash;
	}

	/** Open the frame a `'` opens after text `p`.
	 * @param {string} p */
	single(p) {
		const dollars = endRun(p, "$").length;
		this.push(dollars % 2 ? "E" : "S");
	}

	/** Record `recorded` as a span and return the sentinel standing for it.
	 * @param {string} recorded */
	recordSpan(recorded) {
		this.spans.push(recorded);
		return `${QUOTED}${this.spans.length - 1}${SENTINEL_BYTE}`;
	}

	/** Close the innermost frame on its closing character; closing the
	 * outermost records the span and blanks it.
	 * @param {string} c */
	pop(c) {
		this.frames = this.frames.slice(0, -1);
		if (this.frames) {
			this.span += c;
			return;
		}
		this.out += this.recordSpan(this.quote + this.span);
		this.span = "";
	}

	/** @param {string} text */
	lex(text) {
		let i = 0;
		while (i >= 0 && i < text.length) i = this.lexStep(text, i);
	}

	/**
	 * Read on from `i` in the innermost frame; where to read on from, or -1
	 * where the text is used up.
	 * @param {string} text
	 * @param {number} i
	 */
	lexStep(text, i) {
		if (this.escaped) return this.lexEscaped(text, i);
		const f = this.frames.slice(-1);
		const n = this.frames.length - 1;
		switch (f) {
			case "":
				return this.lexTop(text, i);
			case "S":
				return this.lexSingle(text, i);
			case "E":
			case "D":
				return this.lexQuoted(text, i, f);
			case "C":
				return this.lexSubst(text, i, n);
			default:
				return this.lexHeredoc(text, i, n);
		}
	}

	/** The character a backslash escaped. At top level a `\`-newline is no
	 * break to bash, so both vanish.
	 * @param {string} text
	 * @param {number} i */
	lexEscaped(text, i) {
		this.escaped = false;
		const c = text.charAt(i);
		if (this.frames) this.span += c;
		else if (c === SENTINEL_BYTE) this.out += this.recordSpan(`\\${c}`);
		else if (c !== "\n") this.out += `\\${c}`;
		return i + 1;
	}

	/** Outside every quote.
	 * @param {string} text
	 * @param {number} from */
	lexTop(text, from) {
		let i = from;
		/* A `#` opening a word comments out the rest of its line, quotes and a
		 * trailing `\` included. */
		if (this.inComment) {
			const nl = text.indexOf("\n", i);
			if (nl < 0) return -1;
			i = nl;
			this.inComment = false;
		}
		const j = indexOfAny(text, `'"\\#${SENTINEL_BYTE}`, i);
		if (j < 0) {
			this.out += text.slice(i);
			return -1;
		}
		const p = text.slice(i, j);
		const c = text.charAt(j);
		this.out += p;
		if (c === "#") {
			if (isWordStart(this.out)) this.inComment = true;
			else this.out += "#";
		} else if (c === "\\") this.escaped = true;
		else if (c === SENTINEL_BYTE) this.out += this.recordSpan(c);
		else this.openQuote(c, p);
		return j + 1;
	}

	/** Open an outermost span on quote `c`, after text `p`.
	 * @param {string} c
	 * @param {string} p */
	openQuote(c, p) {
		this.prefix = this.out;
		this.quote = c;
		this.opens++;
		if (c === '"') this.push("D");
		else this.single(p);
	}

	/** Inside `'…'`, where nothing but `'` is special.
	 * @param {string} text
	 * @param {number} i */
	lexSingle(text, i) {
		const j = text.indexOf("'", i);
		if (j < 0) {
			this.span += text.slice(i);
			return -1;
		}
		this.span += text.slice(i, j);
		this.pop("'");
		return j + 1;
	}

	/** Inside `$'…'` (E) or `"…"` (D).
	 * @param {string} text
	 * @param {number} i
	 * @param {string} f */
	lexQuoted(text, i, f) {
		const j = indexOfAny(text, f === "E" ? "'\\" : '"\\$', i);
		if (j < 0) {
			this.span += text.slice(i);
			return -1;
		}
		this.span += text.slice(i, j);
		const c = text.charAt(j);
		const k = j + 1;
		if (c === "\\") {
			this.span += c;
			this.escaped = true;
		} else if (c === "$") {
			this.span += c;
			if (text.charAt(k) === "(") {
				this.span += "(";
				this.push("C");
				return k + 1;
			}
		} else this.pop(c);
		return k;
	}

	/** Inside a `$(…)`, whose slot is `n`.
	 * @param {string} text
	 * @param {number} i
	 * @param {number} n */
	lexSubst(text, i, n) {
		const j = indexOfAny(text, "()'\"\\<\n", i);
		if (j < 0) {
			this.span += text.slice(i);
			return -1;
		}
		const p = text.slice(i, j);
		const c = text.charAt(j);
		const k = j + 1;
		this.span += p + c;
		switch (c) {
			case "(":
				this.depth[n] = (this.depth[n] ?? 0) + 1;
				break;
			case ")":
				this.closeSubst(n);
				break;
			case "\\":
				this.escaped = true;
				break;
			case "'":
				this.single(p);
				break;
			case '"':
				this.push("D");
				break;
			case "<":
				return this.lexHeredocOpener(text, k, n);
			default:
				this.openHeredocBody(n);
		}
		return k;
	}

	/** A `)` inside a `$(…)`. A C is never outermost, so it closes without
	 * `pop`.
	 * @param {number} n */
	closeSubst(n) {
		this.depth[n] = (this.depth[n] ?? 0) - 1;
		if (this.depth[n] === 0) this.frames = this.frames.slice(0, -1);
	}

	/** After a `<` inside a `$(…)`: a heredoc opener records its terminator
	 * for the line's end.
	 * @param {string} text
	 * @param {number} i
	 * @param {number} n */
	lexHeredocOpener(text, i, n) {
		/* A `<<<` here-string opens no body; its third `<` must not read as
		 * one. */
		if (text.startsWith("<<", i)) {
			this.span += "<<";
			return i + 2;
		}
		const m =
			/^<(-?)[ \t\n\v\f\r]*\\?(['"]?)([A-Za-z_][A-Za-z0-9_]*)(['"]?)/.exec(
				text.slice(i),
			);
		if (this.term[n] || !m || m[2] !== m[4]) return i;
		this.dash[n] = m[1] ?? "";
		this.term[n] = m[3] ?? "";
		this.span += m[0];
		return i + m[0].length;
	}

	/** A newline inside a `$(…)`: where a heredoc opened on the line it ends,
	 * its body runs from here to the terminator line.
	 * @param {number} n */
	openHeredocBody(n) {
		const term = this.term[n];
		if (!term) return;
		this.push("H", term, this.dash[n]);
		this.term[n] = "";
		this.heredocLine = "";
	}

	/** Inside a heredoc body, read a line at a time against its terminator.
	 * @param {string} text
	 * @param {number} i
	 * @param {number} n */
	lexHeredoc(text, i, n) {
		const j = text.indexOf("\n", i);
		if (j < 0) {
			this.span += text.slice(i);
			this.heredocLine += text.slice(i);
			return -1;
		}
		const p = text.slice(i, j);
		this.span += `${p}\n`;
		let line = this.heredocLine + p;
		this.heredocLine = "";
		if (this.dash[n]) line = line.replace(/^\t+/, "");
		if (line === this.term[n]) this.frames = this.frames.slice(0, -1);
		return j + 1;
	}

	/**
	 * Where the `$(…)` whose text starts at `from` ends, just past its `)`, or
	 * -1. Read by the C frame, so its quotes, brackets and heredocs nest as they
	 * did when the span was masked.
	 * @param {string} text
	 * @param {number} from
	 */
	static substitutionEnd(text, from) {
		const lx = new Lexer([]);
		lx.push("C");
		let i = from;
		while (lx.frames && i >= 0 && i < text.length) i = lx.lexStep(text, i);
		return lx.frames ? -1 : i;
	}

	/** The quote open where the lexer stands — `\` where a line is still to
	 * come — or "". */
	open() {
		if (this.frames) return this.quote;
		return this.escaped ? "\\" : "";
	}

	/** The masked text so far. An UNTERMINATED quote is left alone: the rest
	 * of the text is literal, each sentinel byte in it recorded as a bare
	 * span. Call it once per text: each call records those spans again. */
	masked() {
		if (!this.frames) return this.out;
		const tail = this.span.replaceAll(SENTINEL_BYTE, (c) => this.recordSpan(c));
		return this.prefix + this.quote + tail;
	}
}

module.exports = { Lexer, SPACE };
