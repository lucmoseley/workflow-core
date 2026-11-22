const { scanJs, stripComments } = require("./strip-comments.js");

const BOUND_TO_RE = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\+?=\s*$/;

// guess, #5529
const BINDING_LOOKBACK = 120;

const REASON_NAME_RE = /^(?:\w+_)?REASON$/;

const DENY_SITE_RE = /(?<![\w$.])deny\s*([:(])/g;

const DECLARED_RE = /\bfunction\s*$/;

const NAME_RE = /(?<![\w$.])[A-Za-z_$][\w$]*/g;

const ASSIGNED_RE = /(?<![\w$.?])([A-Za-z_$][\w$]*)\s*(?:\+?=(?![=>])|:(?!:))/g;

const FUNCTION_RE =
	/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(|(?<![\w$.])([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/g;

const OPENERS = "([{";
const CLOSERS = ")]}";

const DECIDE_FROM_RE =
	/(?:^|\})[^{}]*\{(?=[^}]*\bdecide\b)[^}]*\}\s*=\s*require\(\s*["'](\.\/lib\/[\w.-]+)["']\s*\)/;

/**
 * @param {string} literal
 * @param {(expr: string) => string} fill
 */
function textOf(literal, fill) {
	const inner = literal.slice(1, -1);
	const filled = literal.startsWith("`")
		? inner.replace(/\$\{([^}]*)\}/g, (_, expr) => fill(expr.trim()))
		: inner;
	return filled.replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c));
}

/**
 * @param {string} code
 * @param {number} from
 * @param {boolean} args
 */
function expressionEnd(code, from, args) {
	let depth = 0;
	for (let i = from; i < code.length; i++) {
		const c = code.charAt(i);
		if (OPENERS.includes(c)) depth++;
		else if (CLOSERS.includes(c)) {
			if (depth === 0) return i;
			depth--;
		} else if (!args && depth === 0 && (c === "," || c === ";")) return i;
	}
	return code.length;
}

/**
 * @param {string} code
 * @param {number} from
 * @param {boolean} declared
 * @returns {[number, number]}
 */
function bodySpan(code, from, declared) {
	const start = declared ? expressionEnd(code, from, true) + 1 : from;
	const open = code.slice(start).search(/\S/) + start;
	if (code.charAt(open) !== "{")
		return [open, expressionEnd(code, open, false)];
	return [open + 1, expressionEnd(code, open + 1, true)];
}

/**
 * @param {string} blank
 * @param {Map<string, [number, number]>} bodies
 * @returns {[number, number][]}
 */
function denySites(blank, bodies) {
	/** @type {[number, number][]} */
	const sites = callSpans(blank, DENY_SITE_RE);
	/** @type {Set<string>} */
	const denying = new Set();
	for (let grew = true; grew; ) {
		const found = [...bodies].filter(
			([name, [start, end]]) =>
				!denying.has(name) &&
				sites.some(([from]) => from >= start && from < end),
		);
		for (const [name] of found) {
			denying.add(name);
			sites.push(...callSpans(blank, callRe(name)));
		}
		grew = found.length > 0;
	}
	return sites;
}

/**
 * @param {string} blank
 * @param {RegExp} re
 * @returns {[number, number][]}
 */
function callSpans(blank, re) {
	return [...blank.matchAll(re)]
		.filter((m) => !DECLARED_RE.test(blank.slice(0, m.index)))
		.map((m) => {
			const from = m.index + m[0].length;
			return [from, expressionEnd(blank, from, m[0].endsWith("("))];
		});
}

/** @param {string} name */
const callRe = (name) =>
	new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\s*\\(`, "g");

/**
 * @typedef {{ at: number, raw: string }} Literal
 * @typedef {{
 * blank: string,
 * literals: Literal[],
 * bound: Map<string, string[]>,
 * bodies: Map<string, [number, number]>,
 * assigned: Map<string, [number, number][]>,
 * }} Lexed
 */

/**
 * @param {string} source
 * @returns {Lexed}
 */
function lex(source) {
	const { comments, literals } = scanJs(source);
	// #4170
	const units = source.split("");
	for (const [from, to] of comments) units.fill(" ", from, to);
	for (const { at, raw } of literals) units.fill("0", at, at + raw.length);
	const blank = units.join("");

	/** @type {Lexed} */
	const lx = {
		blank,
		literals,
		bound: new Map(),
		bodies: new Map(),
		assigned: new Map(),
	};
	for (const { at, raw } of literals) {
		const name = BOUND_TO_RE.exec(
			blank.slice(Math.max(0, at - BINDING_LOOKBACK), at),
		)?.[1];
		if (name !== undefined)
			lx.bound.set(name, [...(lx.bound.get(name) ?? []), textIn(lx, raw)]);
	}
	for (const m of blank.matchAll(FUNCTION_RE)) {
		const name = m[1] ?? m[2];
		if (name !== undefined && !lx.bodies.has(name))
			lx.bodies.set(
				name,
				bodySpan(blank, m.index + m[0].length, m[1] !== undefined),
			);
	}
	for (const m of blank.matchAll(ASSIGNED_RE)) {
		const name = m[1] ?? "";
		const from = m.index + m[0].length;
		const spans = lx.assigned.get(name) ?? [];
		spans.push([from, expressionEnd(blank, from, false)]);
		lx.assigned.set(name, spans);
	}
	return lx;
}

/**
 * @param {Lexed} lx
 * @param {string} raw
 */
const textIn = (lx, raw) =>
	textOf(raw, (expr) => lx.bound.get(expr)?.[0] ?? " ");

/**
 * @param {Lexed} lx
 * @param {[number, number]} span
 * @param {Set<string>} texts
 * @param {Set<string>} followed
 */
function reach(lx, [from, to], texts, followed) {
	for (const { at, raw } of lx.literals)
		if (at >= from && at < to) texts.add(textIn(lx, raw));
	for (const [name] of lx.blank.slice(from, to).matchAll(NAME_RE)) {
		for (const b of lx.bound.get(name) ?? []) texts.add(b);
		if (followed.has(name)) continue;
		followed.add(name);
		for (const span of followedSpans(lx, name))
			reach(lx, span, texts, followed);
	}
}

/**
 * @param {Lexed} lx
 * @param {string} name
 * @returns {[number, number][]}
 */
function followedSpans(lx, name) {
	const body = lx.bodies.get(name);
	if (body !== undefined) return [body];
	if (lx.bound.has(name)) return [];
	return lx.assigned.get(name) ?? [];
}

/**
 * @param {string} source
 * @returns {string[]}
 */
function coreDenyTexts(source) {
	const lx = lex(source);
	/** @type {Set<string>} */
	const texts = new Set();
	for (const [name, strings] of lx.bound)
		if (REASON_NAME_RE.test(name)) for (const s of strings) texts.add(s);
	/** @type {Set<string>} */
	const followed = new Set();
	for (const site of denySites(lx.blank, lx.bodies))
		reach(lx, site, texts, followed);
	return [...texts];
}

/** @param {string} source */
function decideModule(source) {
	return DECIDE_FROM_RE.exec(stripComments(source))?.[1] ?? null;
}

module.exports = { coreDenyTexts, decideModule };
