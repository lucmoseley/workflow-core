/*
 * posix-ere.js — a POSIX extended regex as bash's `=~` compiles it, glibc's
 * regcomp with REG_EXTENDED, turned into a JavaScript RegExp (#2790).
 *
 * WHY. pgrep and pkill compile their pattern with that regcomp too, so a guard
 * judging whether a pattern selects some text must read it the way they do.
 * A JavaScript RegExp built from the pattern as written disagrees on bracket
 * expressions (`[[:alpha:]]`, a backslash inside brackets, a leading `]`),
 * on `\<` and `\>`, on intervals and on a quantifier with nothing to repeat.
 *
 * A CORE: no I/O. `compileEre` answers null where glibc refuses the pattern —
 * pgrep then exits 2 and selects nothing — and a RegExp otherwise; `.`
 * matches a newline, as it does without REG_NEWLINE.
 *
 * LIMITS
 *  - The locale is read as C: `[[:alpha:]]` and `\w` are ASCII, and a range
 *    is ordered by code point. Under a UTF-8 locale glibc's classes also take
 *    non-ASCII letters.
 *  - `[=c=]` and `[.c.]` take one character; a multi-character collating
 *    element is refused, as the C locale refuses it.
 */

/** The bracket classes glibc's regcomp knows, as JavaScript class bodies. */
const CLASSES = {
	alpha: "A-Za-z",
	digit: "0-9",
	alnum: "0-9A-Za-z",
	upper: "A-Z",
	lower: "a-z",
	space: " \\t\\n\\r\\f\\v",
	blank: " \\t",
	punct: "!-\\/:-@\\[-`{-~",
	print: "\\x20-\\x7e",
	graph: "\\x21-\\x7e",
	cntrl: "\\x00-\\x1f\\x7f",
	xdigit: "0-9A-Fa-f",
};

/** A GNU escape outside brackets, as JavaScript writes it. */
const GNU_ESCAPES = {
	"<": "\\b(?=\\w)",
	">": "\\b(?<=\\w)",
	b: "\\b",
	B: "\\B",
	w: "\\w",
	W: "\\W",
	s: "\\s",
	S: "\\S",
	"`": "^",
	"'": "$",
};

/** @param {number} cp */
const classChar = (cp) => `\\u{${cp.toString(16)}}`;

/** @param {string} c */
const literalChar = (c) => c.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

/**
 * The bracket expression opening at `pattern[at]` (its `[`): the JavaScript
 * class and the index after its `]`; null where glibc refuses it.
 * @param {string} pattern
 * @param {number} at
 * @returns {{ js: string, end: number } | null}
 */
function bracket(pattern, at) {
	const negate = pattern[at + 1] === "^";
	let i = at + (negate ? 2 : 1);
	let body = "";
	/* A `]` first in the list is a member, not the close. */
	let first = true;
	while (first || pattern[i] !== "]") {
		if (i >= pattern.length) return null;
		first = false;
		const item = bracketItem(pattern, i);
		if (!item) return null;
		body += item.js;
		i = item.end;
	}
	return { js: `[${negate ? "^" : ""}${body}]`, end: i + 1 };
}

/**
 * One member of a bracket list at `pattern[i]` — a class, a character or a
 * range — as JavaScript class text; null where glibc refuses it.
 * @param {string} pattern
 * @param {number} i
 * @returns {{ js: string, end: number } | null}
 */
function bracketItem(pattern, i) {
	const el = element(pattern, i);
	if (!el) return null;
	if ("cls" in el) return { js: el.cls, end: el.end };
	const j = el.end;
	if (pattern[j] !== "-" || pattern[j + 1] === "]" || j + 1 >= pattern.length)
		return { js: classChar(el.cp), end: j };
	const hi = element(pattern, j + 1);
	if (!hi || "cls" in hi || hi.cp < el.cp) return null;
	return { js: `${classChar(el.cp)}-${classChar(hi.cp)}`, end: hi.end };
}

/**
 * One bracket element at `pattern[i]`: a character's code point, or a class's
 * body; null where glibc refuses it.
 * @param {string} pattern
 * @param {number} i
 * @returns {{ cp: number, end: number } | { cls: string, end: number } | null}
 */
function element(pattern, i) {
	const open = pattern.slice(i, i + 2);
	if (open === "[:" || open === "[=" || open === "[.") {
		const kind = open.charAt(1);
		const close = pattern.indexOf(`${kind}]`, i + 2);
		if (close < 0) return null;
		const name = pattern.slice(i + 2, close);
		const end = close + 2;
		if (kind === ":") {
			const cls = CLASSES[/** @type {keyof typeof CLASSES} */ (name)];
			return cls === undefined ? null : { cls, end };
		}
		const chars = [...name];
		const only = chars[0];
		return chars.length === 1 && only !== undefined
			? { cp: /** @type {number} */ (only.codePointAt(0)), end }
			: null;
	}
	const cp = /** @type {number} */ (pattern.codePointAt(i));
	return { cp, end: i + String.fromCodePoint(cp).length };
}

/**
 * An interval at `pattern[at]` (its `{`): the JavaScript quantifier and the
 * index after its `}`; null where glibc refuses it.
 * @param {string} pattern
 * @param {number} at
 * @returns {{ js: string, end: number } | null}
 */
function interval(pattern, at) {
	const m = /^\{([0-9]*)(,([0-9]*))?\}/.exec(pattern.slice(at));
	if (!m) return null;
	const lo = m[1] === "" ? 0 : Number(m[1]);
	if (m[2] === undefined) {
		if (m[1] === "") return null;
		return { js: `{${lo}}`, end: at + m[0].length };
	}
	const hi = m[3] === "" || m[3] === undefined ? null : Number(m[3]);
	if (hi !== null && hi < lo) return null;
	return { js: `{${lo},${hi ?? ""}}`, end: at + m[0].length };
}

/**
 * A translation under way: `atom` is where the last atom began in `out`, -1
 * where a quantifier has nothing to repeat, and `quantified` whether that atom
 * already carries one; `open` holds where each open group began.
 * @typedef {{ out: string, atom: number, quantified: boolean, groups: number,
 *   open: number[] }} Translation
 */

/**
 * @param {Translation} t
 * @param {string} js
 */
function pushAtom(t, js) {
	t.atom = t.out.length;
	t.quantified = false;
	t.out += js;
}

/**
 * @param {Translation} t
 * @param {string} q
 */
function quantify(t, q) {
	if (t.atom < 0) return false;
	/* glibc repeats a repeat: `a**` and `a{1}{2}` compile. */
	if (t.quantified)
		t.out = `${t.out.slice(0, t.atom)}(?:${t.out.slice(t.atom)})`;
	t.out += q;
	t.quantified = true;
	return true;
}

/**
 * The escape of `next`: false where glibc refuses it.
 * @param {Translation} t
 * @param {string} next the character after the backslash, "" at the end
 * @param {boolean} icase
 */
function escapeAtom(t, next, icase) {
	if (next === "") return false;
	if (/[1-9]/.test(next)) {
		if (Number(next) > t.groups) return false;
		pushAtom(t, `\\${next}`);
	} else if (icase && /[a-z]/.test(next) && !(next in GNU_ESCAPES))
		/* glibc folds the subject to upper case under REG_ICASE but leaves
		 * an escaped letter as written, so `\d` matches neither d nor D
		 * and `\D` matches both. */
		pushAtom(t, "(?!)");
	else
		pushAtom(
			t,
			GNU_ESCAPES[/** @type {keyof typeof GNU_ESCAPES} */ (next)] ??
				literalChar(next),
		);
	return true;
}

/**
 * A group, an alternation, an anchor or `.`: false where `c` is none of them,
 * an unmatched `)` among them, glibc reading that as a literal.
 * @param {Translation} t
 * @param {string} c
 */
function operator(t, c) {
	if (c === "(") {
		t.groups++;
		t.open.push(t.out.length);
		t.out += "(";
		t.atom = -1;
	} else if (c === ")" && t.open.length > 0) {
		t.atom = /** @type {number} */ (t.open.pop());
		t.out += ")";
		t.quantified = false;
	} else if (c === "|" || c === "^" || c === "$") {
		t.out += c;
		t.atom = -1;
	} else if (c === ".") pushAtom(t, ".");
	else return false;
	return true;
}

/**
 * The token at `pattern[i]` translated: the index after it, or -1 where
 * glibc refuses it.
 * @param {Translation} t
 * @param {string} pattern
 * @param {number} i
 * @param {boolean} icase
 */
function step(t, pattern, i, icase) {
	const c = pattern.charAt(i);
	if (c === "\\")
		return escapeAtom(t, pattern.charAt(i + 1), icase) ? i + 2 : -1;
	if (c === "[") {
		const b = bracket(pattern, i);
		if (!b) return -1;
		pushAtom(t, b.js);
		return b.end;
	}
	if (c === "{") {
		const q = interval(pattern, i);
		return q && quantify(t, q.js) ? q.end : -1;
	}
	if (c === "*" || c === "+" || c === "?") return quantify(t, c) ? i + 1 : -1;
	if (operator(t, c)) return i + 1;
	const ch = String.fromCodePoint(
		/** @type {number} */ (pattern.codePointAt(i)),
	);
	pushAtom(t, literalChar(ch));
	return i + ch.length;
}

/**
 * The pattern as a JavaScript RegExp, or null where glibc's regcomp refuses
 * it.
 * @param {string} pattern
 * @param {{ icase?: boolean }} [opts]
 * @returns {RegExp | null}
 */
function compileEre(pattern, { icase = false } = {}) {
	/** @type {Translation} */
	const t = { out: "", atom: -1, quantified: false, groups: 0, open: [] };
	for (let i = 0; i < pattern.length; ) {
		i = step(t, pattern, i, icase);
		if (i < 0) return null;
	}
	if (t.open.length > 0) return null;
	try {
		return new RegExp(t.out, icase ? "isu" : "su");
	} catch {
		return null;
	}
}

module.exports = { compileEre };
