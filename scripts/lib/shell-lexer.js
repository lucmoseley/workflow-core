const { QUOTED, SENTINEL_BYTE, MARK_BYTES } = require("./shell-words.js");
const { endRun } = require("./trim-run.js");

const SPACE = " \t\n\v\f\r";

const MARK_RE = new RegExp(`[${MARK_BYTES}]`, "g");

/** @param {string} s */
const isWordStart = (s) => s === "" || `${SPACE};&|()`.includes(s.slice(-1));

/** @param {string} text @param {string} chars @param {number} from */
function indexOfAny(text, chars, from) {
	for (let j = from; j < text.length; j++)
		if (chars.includes(text.charAt(j))) return j;
	return -1;
}

class Lexer {
	/** @param {string[]} spans */
	constructor(spans) {
		this.spans = spans;
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

	/** @param {string} p */
	single(p) {
		const dollars = endRun(p, "$").length;
		this.push(dollars % 2 ? "E" : "S");
	}

	/** @param {string} recorded */
	recordSpan(recorded) {
		this.spans.push(recorded);
		return `${QUOTED}${this.spans.length - 1}${SENTINEL_BYTE}`;
	}

	/** @param {string} c */
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

	/** @param {string} text @param {number} i */
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

	/** @param {string} text @param {number} i */
	lexEscaped(text, i) {
		this.escaped = false;
		const c = text.charAt(i);
		if (this.frames) this.span += c;
		else if (MARK_BYTES.includes(c)) this.out += this.recordSpan(`\\${c}`);
		else if (c !== "\n") this.out += `\\${c}`;
		return i + 1;
	}

	/** @param {string} text @param {number} from */
	lexTop(text, from) {
		let i = from;
		if (this.inComment) {
			const nl = text.indexOf("\n", i);
			if (nl < 0) return -1;
			i = nl;
			this.inComment = false;
		}
		const j = indexOfAny(text, `'"\\#${MARK_BYTES}`, i);
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
		else if (MARK_BYTES.includes(c)) this.out += this.recordSpan(c);
		else this.openQuote(c, p);
		return j + 1;
	}

	/** @param {string} c @param {string} p */
	openQuote(c, p) {
		this.prefix = this.out;
		this.quote = c;
		this.opens++;
		if (c === '"') this.push("D");
		else this.single(p);
	}

	/** @param {string} text @param {number} i */
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

	/** @param {string} text @param {number} i @param {string} f */
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

	/** @param {string} text @param {number} i @param {number} n */
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

	/** @param {number} n */
	closeSubst(n) {
		this.depth[n] = (this.depth[n] ?? 0) - 1;
		if (this.depth[n] === 0) this.frames = this.frames.slice(0, -1);
	}

	/** @param {string} text @param {number} i @param {number} n */
	lexHeredocOpener(text, i, n) {
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

	/** @param {number} n */
	openHeredocBody(n) {
		const term = this.term[n];
		if (!term) return;
		this.push("H", term, this.dash[n]);
		this.term[n] = "";
		this.heredocLine = "";
	}

	/** @param {string} text @param {number} i @param {number} n */
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

	/** @param {string} text @param {number} from */
	static substitutionEnd(text, from) {
		const lx = new Lexer([]);
		lx.push("C");
		let i = from;
		while (lx.frames && i >= 0 && i < text.length) i = lx.lexStep(text, i);
		return lx.frames ? -1 : i;
	}

	open() {
		if (this.frames) return this.quote;
		return this.escaped ? "\\" : "";
	}

	masked() {
		if (!this.frames) return this.out;
		const tail = this.span.replace(MARK_RE, (c) => this.recordSpan(c));
		return this.prefix + this.quote + tail;
	}
}

module.exports = { Lexer, SPACE };
