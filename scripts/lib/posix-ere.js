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
 * @param {string} pattern
 * @param {number} at
 * @returns {{ js: string, end: number } | null}
 */
function bracket(pattern, at) {
	const negate = pattern[at + 1] === "^";
	let i = at + (negate ? 2 : 1);
	let body = "";
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
