/*
 * core-deny-text.js — the refusal texts a Node guard core can print, read
 * from its source without loading it (#3001), for check-guard-registry.js's
 * REPRINTED pass. The bash reader there follows `gp_deny`; a core ported
 * under #2733 denies by returning `{ deny: … }` instead.
 *
 * A core's deny text is every string bound to a `REASON` or `*_REASON` name,
 * and whatever a deny site reaches. A site is a `deny:` value or the
 * arguments of a `deny(…)` call, lib/guard-verdict.js's refusal. It reaches:
 *   - every literal inside it;
 *   - every string bound to a name it mentions, so `deny:
 *     ctx.corePaths(withWait(REASON, w))` reads REASON's text;
 *   - the body of a function it calls that the file declares, read as a site
 *     itself, so `deny: refusal(found, ctx)` reads refusal()'s wording;
 *   - for a name no string is bound to, every value assigned to it or keyed by
 *     it, read as a site itself: `deny: refusal` reads `refusal =
 *     refusalText(…)`, and `denyText(ctx, segment, reason)` reads every
 *     `reason: …` key in the file.
 * A template's `${name}` is filled from the first string bound to that name,
 * any other placeholder read as a gap.
 *
 * LEXICAL, AND IT FAILS SHORT: a string reached only through an import, or
 * through a property read (`out.deny`), is unseen, costing coverage. A rule fragment the core prints through
 * `ctx.ruleText(<id>)` is not its text either. Names are read file-wide, scope
 * ignored, and a followed function's whole body is read, so a warning worded
 * in a function that also denies counts as deny text.
 */

const { scanJs, stripComments } = require("./strip-comments.js");

/* The name a literal is bound to: `const X = `, `x = `, `x += `. Its tail
 * meets a lone `=`, so `==`, `<=` and `=>` never match. */
const BOUND_TO_RE = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\+?=\s*$/;

/* How far back of a literal its binding is looked for. The longest live
 * spelling, `const SOME_LONG_REASON =` and its indent, is under 40; 120 is a
 * guess that leaves room for a type cast or a wrapped line. */
const BINDING_LOOKBACK = 120;

const REASON_NAME_RE = /^(?:\w+_)?REASON$/;

const DENY_SITE_RE = /(?<![\w$.])deny\s*([:(])/g;

const DECLARED_RE = /\bfunction\s*$/;

const NAME_RE = /(?<![\w$.])[A-Za-z_$][\w$]*/g;

/* `name = ` or `name: ` opening a value, `==`, `=>` and `?.` aside. */
const ASSIGNED_RE = /(?<![\w$.?])([A-Za-z_$][\w$]*)\s*(?:\+?=(?![=>])|:(?!:))/g;

/* `function name(` or `name = (…) =>` / `name = x =>`, up to the arrow or the
 * parameter list's opener. */
const FUNCTION_RE =
	/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(|(?<![\w$.])([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/g;

const OPENERS = "([{";
const CLOSERS = ")]}";

/* `decide` destructured off a sibling module, as an entry running a core
 * through guard-entry.js's `run()` takes it. */
/* Opened at a run's first `{` after a `}`: a later `{` before the same `}`
 * shares its tail, so trying it again only re-reads the run. */
const DECIDE_FROM_RE =
	/(?:^|\})[^{}]*\{(?=[^}]*\bdecide\b)[^}]*\}\s*=\s*require\(\s*["'](\.\/lib\/[\w.-]+)["']\s*\)/;

/**
 * A literal's text, quotes dropped and escapes read. A template's
 * placeholders are filled by `fill`.
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
 * Where the expression starting at `from` ends: the closer of a bracket it did
 * not open, or, unless `args`, the first `,` or `;` at its own depth.
 * @param {string} code literals blanked, so their brackets do not count
 * @param {number} from
 * @param {boolean} args a call's whole argument list, commas and all
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
 * The span of the body of the function whose header ends at `from`: its
 * braced block, or an arrow's bare expression. A `function` header's
 * parameter list is skipped first.
 * @param {string} code literals blanked
 * @param {number} from just past `(` for a `function`, past `=>` for an arrow
 * @param {boolean} declared a `function` declaration
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
 * The spans of every deny site: each `deny:` value and `deny(…)` call, then,
 * to a fixed point, the arguments of each call to a declared function whose
 * body holds a site — so `refuse(TEXT, segment)` is one where refuse()'s
 * body is `{ deny: spliceCmd(segment, text) }`.
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
 * Each match's value or argument span, past a declaration's own name.
 * @param {string} blank
 * @param {RegExp} re a key or call, ending at its `:` or `(`
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
 *   blank: string,
 *   literals: Literal[],
 *   bound: Map<string, string[]>,
 *   bodies: Map<string, [number, number]>,
 *   assigned: Map<string, [number, number][]>,
 * }} Lexed `blank` the source with comments spaced out and literals filled
 *   with `0`, so offsets still index the source and no bracket or name inside
 *   either counts as code, yet an arrow's bare-literal body is still found;
 *   `bound` each name's strings in source order; `bodies` each declared
 *   function's body span; `assigned` each name's assigned or keyed values
 */

/**
 * @param {string} source
 * @returns {Lexed}
 */
function lex(source) {
	const { comments, literals } = scanJs(source);
	let blank = source;
	for (const [from, to] of comments)
		blank = blank.slice(0, from) + " ".repeat(to - from) + blank.slice(to);
	for (const { at, raw } of literals)
		blank =
			blank.slice(0, at) +
			"0".repeat(raw.length) +
			blank.slice(at + raw.length);

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
 * A literal's text, its placeholders filled from the strings bound so far.
 * @param {Lexed} lx
 * @param {string} raw
 */
const textIn = (lx, raw) =>
	textOf(raw, (expr) => lx.bound.get(expr)?.[0] ?? " ");

/**
 * Add to `texts` what the span from `from` to `to` reaches.
 * @param {Lexed} lx
 * @param {[number, number]} span
 * @param {Set<string>} texts accumulator: each text reached is added
 * @param {Set<string>} followed accumulator: the names already followed
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
 * Where a name a site mentions leads: a declared function's body, or, for a
 * name no string is bound to, every value assigned to it or keyed by it.
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
 * Every deny text the core in `source` can print, raw.
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

/**
 * The module an entry takes its core's `decide` from, as a path relative to
 * the entry's directory, or null where it runs no core.
 * @param {string} source
 */
function decideModule(source) {
	return DECIDE_FROM_RE.exec(stripComments(source))?.[1] ?? null;
}

module.exports = { coreDenyTexts, decideModule };
