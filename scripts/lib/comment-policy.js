/*
 * comment-policy.js — the comment-policy gate's core (#5490, ruled at
 * #5477): a source file's comments as units, and each unit's verdict
 * against the permitted kinds #5455 lists. Pure: the shell,
 * scripts/check-comment-policy.js, reads the files and the facts a verdict
 * needs and hands them in.
 */

const { escapeRe } = require("./regex-group.js");
const { scanJs } = require("./strip-comments.js");

/**
 * @typedef {"js" | "py" | "sh"} Lang
 * @typedef {{
 *   line: number,
 *   lines: string[],
 *   top: boolean,
 *   jsdoc: boolean,
 *   next: string,
 *   owner: string,
 * }} Unit one comment: a block, a run of own-line line comments, a trailing
 *   comment or a Python string statement. `lines` its text, markers off;
 *   `top` no code before it; `next` the code line it sits on; `owner` for a
 *   docstring the `def` or `class` line it documents
 * @typedef {{ tool: string, rules: string[] }} Suppression
 * @typedef {{
 *   lang: Lang,
 *   checkJs: boolean,
 *   exports: Set<string>,
 *   shipped: boolean,
 *   adrs: Set<string>,
 *   deps: RegExp | null,
 *   styleOnly: Record<string, string[]>,
 * }} FileFacts `exports` the names the helper surface lists for the file;
 *   `shipped` the file is a surface entry point or command; `adrs` the
 *   `NNNN` of each `docs/adr/NNNN-*.md`; `deps` matches a manifest
 *   dependency's name
 * @typedef {{ tag: "COMMENT" | "SUPPRESSION" | "ADR-UNRESOLVED",
 *   line: number, match: string, why: string }} Breach
 */

/** A path that may hold code: a JS, TS, Python or shell extension, or none. */
const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|sh|bash)$|(?:^|\/)[^/.]+$/;

/** @param {string} rel @param {string} text @returns {Lang | null} */
function langOf(rel, text) {
	if (/\.[cm]?[jt]sx?$/.test(rel)) return "js";
	if (rel.endsWith(".py")) return "py";
	if (/\.(?:sh|bash)$/.test(rel)) return "sh";
	if (/(?:^|\/)[^/.]+$/.test(rel) && /^#![^\n]*\b(?:ba|da|z)?sh\b/.test(text))
		return "sh";
	return null;
}

/** @param {string} source */
function lineStarts(source) {
	const starts = [0];
	for (let i = source.indexOf("\n"); i >= 0; i = source.indexOf("\n", i + 1))
		starts.push(i + 1);
	return starts;
}

/**
 * The 1-based line holding `offset`.
 * @param {number[]} starts
 * @param {number} offset
 */
function lineAt(starts, offset) {
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if ((starts[mid] ?? 0) <= offset) lo = mid;
		else hi = mid - 1;
	}
	return lo + 1;
}

/**
 * `source` with a leading `#!` line blanked, its length kept.
 * @param {string} source
 */
const blankShebang = (source) =>
	source.startsWith("#!")
		? source.replace(/^[^\n]*/, (m) => " ".repeat(m.length))
		: source;

/**
 * @typedef {{ start: number, end: number, text: string[], kind: "line" | "block" | "string" }} Raw
 */

/**
 * Raw comment spans folded into units: own-line line comments on
 * consecutive lines join one unit.
 * @param {string} source
 * @param {Raw[]} raws in source order
 * @param {(raw: Raw) => { jsdoc: boolean, owner: string }} extra
 * @returns {Unit[]}
 */
function foldUnits(source, raws, extra) {
	const starts = lineStarts(source);
	const lines = source.split("\n");
	const firstCode = firstCodeOffset(source, raws);
	/** @type {(Unit & { endLine: number, own: boolean, kind: string })[]} */
	const out = [];
	for (const raw of raws) {
		const line = lineAt(starts, raw.start);
		const endLine = lineAt(starts, Math.max(raw.start, raw.end - 1));
		const before = source.slice(starts[line - 1] ?? 0, raw.start);
		const own = before.trim() === "";
		const prev = out.at(-1);
		if (
			prev &&
			raw.kind === "line" &&
			prev.kind === "line" &&
			own &&
			prev.own &&
			prev.endLine === line - 1
		) {
			prev.lines.push(...raw.text);
			prev.endLine = endLine;
			continue;
		}
		const { jsdoc, owner } = extra(raw);
		out.push({
			line,
			endLine,
			own,
			kind: raw.kind,
			lines: [...raw.text],
			top: raw.start <= firstCode,
			jsdoc,
			owner,
			next: own ? "" : before.trim(),
		});
	}
	const commentOnly = commentLines(lines, raws, starts);
	for (const u of out)
		if (u.own) u.next = nextCodeLine(lines, u.endLine, commentOnly);
	return out.map(({ line, lines: text, top, jsdoc, next, owner }) => ({
		line,
		lines: text,
		top,
		jsdoc,
		next,
		owner,
	}));
}

/**
 * Where the first code character sits: the first non-blank offset outside
 * every comment span.
 * @param {string} source
 * @param {Raw[]} raws
 */
function firstCodeOffset(source, raws) {
	let i = 0;
	let r = 0;
	for (;;) {
		while (i < source.length && /\s/.test(source.charAt(i))) i++;
		const raw = raws[r];
		if (raw && raw.start === i && raw.kind !== "string") {
			i = raw.end;
			r++;
			continue;
		}
		if (raw && raw.start < i) {
			r++;
			continue;
		}
		return i;
	}
}

/**
 * The 1-based lines holding nothing but a comment.
 * @param {string[]} lines
 * @param {Raw[]} raws
 * @param {number[]} starts
 */
function commentLines(lines, raws, starts) {
	/** @type {Set<number>} */
	const commentOnly = new Set();
	for (const raw of raws) {
		const from = lineAt(starts, raw.start);
		const to = lineAt(starts, Math.max(raw.start, raw.end - 1));
		const head = (lines[from - 1] ?? "").slice(
			0,
			raw.start - (starts[from - 1] ?? 0),
		);
		if (head.trim() !== "") continue;
		const tail = (lines[to - 1] ?? "").slice(raw.end - (starts[to - 1] ?? 0));
		if (tail.trim() !== "") continue;
		for (let l = from; l <= to; l++) commentOnly.add(l);
	}
	return commentOnly;
}

/**
 * The code line a comment sits on: the line right after `endLine`, past any
 * decorator, or "" where a blank or a comment comes first.
 * @param {string[]} lines
 * @param {number} endLine 1-based
 * @param {Set<number>} commentOnly
 */
function nextCodeLine(lines, endLine, commentOnly) {
	for (let l = endLine + 1; l <= lines.length; l++) {
		const text = (lines[l - 1] ?? "").trim();
		if (text === "" || commentOnly.has(l)) return "";
		if (!text.startsWith("@")) return text;
	}
	return "";
}

/**
 * A block comment's inside, its opening and closing stars off.
 * @param {string} text
 */
function trimBlock(text) {
	let from = 2;
	while (text.charAt(from) === "*") from++;
	let to = text.endsWith("*/") ? text.length - 2 : text.length;
	while (to > from && text.charAt(to - 1) === "*") to--;
	return text.slice(from, to);
}

/** @param {string} body a block comment's inside */
const blockLines = (body) =>
	body.split("\n").map((l) => l.replace(/^\s*\*(?!\/)\s?/, "").trimEnd());

/**
 * @param {string} source
 * @returns {Unit[]}
 */
function jsUnits(source) {
	const src = blankShebang(source);
	/** @type {Raw[]} */
	const raws = scanJs(src).comments.map(([start, end]) => {
		const text = src.slice(start, end);
		if (text.startsWith("//"))
			return { start, end, kind: "line", text: [text.slice(2).trim()] };
		return {
			start,
			end,
			kind: "block",
			text: blockLines(trimBlock(text)),
		};
	});
	return foldUnits(src, raws, (raw) => ({
		jsdoc:
			raw.kind === "block" &&
			src.startsWith("/**", raw.start) &&
			src.charAt(raw.start + 3) !== "/",
		owner: "",
	}));
}

const PY_PREFIX = /^(?:[rRuUbBfF]|[bBfF][rR]|[rR][bBfF])$/;

/**
 * @typedef {{ start: number, end: number, kind: "str" | "word" | "op" }} PyToken
 */

/**
 * @typedef {{ source: string, comments: { start: number, end: number }[],
 *   logical: PyToken[][], current: PyToken[], depth: number }} PyState
 */

/**
 * The end of the word at `i`, or of the string it prefixes.
 * @param {PyState} st accumulator: the word's token is pushed onto `st.current`.
 * @param {number} i
 */
function pyWordEnd(st, i) {
	const { source } = st;
	let j = i;
	while (j < source.length && /\w/.test(source.charAt(j))) j++;
	const q = source.charAt(j);
	const prefixed =
		(q === '"' || q === "'") && PY_PREFIX.test(source.slice(i, j));
	const end = prefixed ? pyStringEnd(source, j) : j;
	st.current.push({ start: i, end, kind: prefixed ? "str" : "word" });
	return end;
}

/**
 * Read the Python token at `i` into `st`, returning where the next starts.
 * @param {PyState} st accumulator: tokens, comments and logical lines grow on it.
 * @param {number} i
 */
function pyStep(st, i) {
	const { source } = st;
	const c = source.charAt(i);
	if (c === "#") {
		const end = source.indexOf("\n", i);
		const stop = end < 0 ? source.length : end;
		st.comments.push({ start: i, end: stop });
		return stop;
	}
	if (c === "\\" && source.charAt(i + 1) === "\n") return i + 2;
	if (c === "\n") {
		if (st.depth === 0 && st.current.length > 0) {
			st.logical.push(st.current);
			st.current = [];
		}
		return i + 1;
	}
	if (/\s/.test(c)) return i + 1;
	if (c === '"' || c === "'") {
		const end = pyStringEnd(source, i);
		st.current.push({ start: i, end, kind: "str" });
		return end;
	}
	if (/\w/.test(c)) return pyWordEnd(st, i);
	if ("([{".includes(c)) st.depth++;
	else if (")]}".includes(c)) st.depth = Math.max(0, st.depth - 1);
	st.current.push({ start: i, end: i + 1, kind: "op" });
	return i + 1;
}

/**
 * Python's comments, and its tokens grouped into logical lines.
 * @param {string} source
 */
function scanPy(source) {
	/** @type {PyState} */
	const st = { source, comments: [], logical: [], current: [], depth: 0 };
	for (let i = 0; i < source.length; ) i = pyStep(st, i);
	if (st.current.length > 0) st.logical.push(st.current);
	return { comments: st.comments, logical: st.logical };
}

/**
 * Where the Python string whose quote opens at `i` ends.
 * @param {string} source
 * @param {number} i
 */
function pyStringEnd(source, i) {
	const q = source.charAt(i);
	const triple = source.startsWith(q.repeat(3), i);
	const close = triple ? q.repeat(3) : q;
	let j = i + close.length;
	while (j < source.length) {
		const c = source.charAt(j);
		if (c === "\\") j += 2;
		else if (source.startsWith(close, j)) return j + close.length;
		else if (c === "\n" && !triple) return j;
		else j++;
	}
	return source.length;
}

/**
 * A Python string literal's text, prefix and quotes off, its common indent
 * removed.
 * @param {string} raw
 */
function pyStringLines(raw) {
	const body = raw
		.replace(/^[A-Za-z]*("""|'''|"|')/, "")
		.replace(/("""|'''|"|')$/, "");
	const lines = body.split("\n");
	const indents = lines
		.slice(1)
		.filter((l) => l.trim() !== "")
		.map((l) => /^\s*/.exec(l)?.[0].length ?? 0);
	const cut = indents.length > 0 ? Math.min(...indents) : 0;
	return lines.map((l, n) => (n === 0 ? l : l.slice(cut)).trimEnd());
}

/**
 * A Python file's comment units: its `#` comments, and every statement that
 * is a string literal alone, docstrings included.
 * @param {string} source
 * @returns {Unit[]}
 */
function pyUnits(source) {
	const src = blankShebang(source);
	const { comments, logical } = scanPy(src);
	/** @type {Map<number, string>} */
	const owners = new Map();
	/** @type {Raw[]} */
	const raws = comments.map(({ start, end }) => ({
		start,
		end,
		kind: "line",
		text: [src.slice(start + 1, end).trim()],
	}));
	logical.forEach((tokens, n) => {
		if (!tokens.every((t) => t.kind === "str")) return;
		const first = tokens[0];
		const last = tokens.at(-1);
		if (!first || !last) return;
		const text = tokens.flatMap((t) =>
			pyStringLines(src.slice(t.start, t.end)),
		);
		raws.push({ start: first.start, end: last.end, kind: "string", text });
		const prev = logical[n - 1];
		const head = prev?.[0];
		const tail = prev?.at(-1);
		if (head && tail && src.charAt(tail.start) === ":")
			owners.set(first.start, src.slice(head.start, tail.end));
	});
	raws.sort((a, b) => a.start - b.start);
	return foldUnits(src, raws, (raw) => ({
		jsdoc: false,
		owner: owners.get(raw.start) ?? "",
	}));
}

const HEREDOC = /<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([\w.-]+))/y;

/**
 * @typedef {{ source: string, raws: Raw[],
 *   pending: { word: string, tabs: boolean }[] }} ShState
 */

/**
 * Where the shell quote opening at `i` closes.
 * @param {string} source
 * @param {number} i
 */
function shQuoteEnd(source, i) {
	const q = source.charAt(i);
	const escapes = q === '"' || source.charAt(i - 1) === "$";
	let j = i + 1;
	while (j < source.length && source.charAt(j) !== q)
		j += source.charAt(j) === "\\" && escapes ? 2 : 1;
	return j + 1;
}

/**
 * @param {ShState} st accumulator: the delimiter is pushed onto `st.pending`.
 * @param {number} i
 */
function shHeredoc(st, i) {
	HEREDOC.lastIndex = i;
	const m = HEREDOC.exec(st.source);
	if (!m) return i + 2;
	const word = m[2] ?? m[3] ?? m[4] ?? "";
	if (!/^\d+$/.test(word)) st.pending.push({ word, tabs: m[1] === "-" });
	return HEREDOC.lastIndex;
}

/**
 * Read the shell token at `i` into `st`, returning where the next starts.
 * @param {ShState} st accumulator: comments and pending heredocs grow on it.
 * @param {number} i
 */
function shStep(st, i) {
	const { source } = st;
	const c = source.charAt(i);
	if (c === "\n") {
		const at = skipHeredocs(source, i + 1, st.pending);
		st.pending = [];
		return at;
	}
	if (c === "#" && /[\s;&|()<>]/.test(i === 0 ? "\n" : source.charAt(i - 1))) {
		const end = source.indexOf("\n", i);
		const stop = end < 0 ? source.length : end;
		const text = [source.slice(i + 1, stop).trim()];
		st.raws.push({ start: i, end: stop, kind: "line", text });
		return stop;
	}
	if (c === "\\") return i + 2;
	if (c === "'" || c === '"') return shQuoteEnd(source, i);
	if (source.startsWith("<<", i) && source.charAt(i + 2) !== "<")
		return shHeredoc(st, i);
	return i + 1;
}

/**
 * A shell file's `#` comments as raw spans: a `#` opening a word, outside a
 * quote and a heredoc body.
 * @param {string} source
 * @returns {Raw[]}
 */
function scanSh(source) {
	/** @type {ShState} */
	const st = { source, raws: [], pending: [] };
	for (let i = 0; i < source.length; ) i = shStep(st, i);
	return st.raws;
}

/**
 * Past each pending heredoc body from `i`, a line's start.
 * @param {string} source
 * @param {number} i
 * @param {{ word: string, tabs: boolean }[]} pending
 */
function skipHeredocs(source, i, pending) {
	let at = i;
	for (const doc of pending) at = pastBody(source, at, doc);
	return at;
}

/**
 * Past one heredoc body from `at`: the line after its delimiter.
 * @param {string} source
 * @param {number} at
 * @param {{ word: string, tabs: boolean }} doc
 */
function pastBody(source, at, doc) {
	let from = at;
	while (from < source.length) {
		const end = source.indexOf("\n", from);
		const line = source.slice(from, end < 0 ? source.length : end);
		from = end < 0 ? source.length : end + 1;
		if ((doc.tabs ? line.replace(/^\t+/, "") : line) === doc.word) break;
	}
	return from;
}

/**
 * @param {string} source
 * @returns {Unit[]}
 */
function shUnits(source) {
	const src = blankShebang(source);
	return foldUnits(src, scanSh(src), () => ({ jsdoc: false, owner: "" }));
}

/** @type {Record<Lang, (source: string) => Unit[]>} */
const UNITS = { js: jsUnits, py: pyUnits, sh: shUnits };

/** JSDoc tags checkJs reads as types, and what follows the `{type}` in each. */
const TYPE_TAGS = new Map([
	["type", "none"],
	["satisfies", "none"],
	["returns", "none"],
	["return", "none"],
	["this", "none"],
	["enum", "none"],
	["extends", "name"],
	["augments", "name"],
	["implements", "name"],
	["param", "name"],
	["arg", "name"],
	["argument", "name"],
	["property", "name"],
	["prop", "name"],
	["typedef", "name"],
	["callback", "name"],
	["template", "names"],
	["import", "all"],
	["overload", "none"],
	["public", "none"],
	["private", "none"],
	["protected", "none"],
	["readonly", "none"],
	["override", "none"],
	["class", "none"],
	["constructor", "none"],
]);

/**
 * Where the `{…}` opening at `i` closes, braces balanced.
 * @param {string} text
 * @param {number} i
 */
function braceEnd(text, i) {
	let depth = 0;
	for (let j = i; j < text.length; j++) {
		if (text.charAt(j) === "{") depth++;
		else if (text.charAt(j) === "}" && --depth === 0) return j + 1;
	}
	return text.length;
}

/**
 * One JSDoc tag's prose: what a type tag carries past its type and name,
 * or the whole of any other tag.
 * @param {string} name
 * @param {string} body the text after `@name`
 */
function tagProse(name, body) {
	const shape = TYPE_TAGS.get(name);
	if (shape === undefined) return `@${name}${body}`;
	if (shape === "all") return "";
	let rest = body.trimStart();
	if (rest.startsWith("{")) rest = rest.slice(braceEnd(rest, 0)).trimStart();
	if (shape === "name")
		rest = rest.replace(/^(?:\[[^\]]*\]|[\w$.[\]]+)/, "").trimStart();
	if (shape === "names")
		rest = rest
			.replace(
				/^[\w$]+(?:\s*=\s*[^\s,]+)?(?:\s*,\s*[\w$]+(?:\s*=\s*[^\s,]+)?)*/,
				"",
			)
			.trimStart();
	return rest.replace(/^-\s*/, "");
}

/**
 * A JSDoc block's prose, its type tags taken out as code.
 * @param {string[]} lines
 * @returns {string[]}
 */
function jsdocProse(lines) {
	const text = lines.join("\n");
	const tags = [...text.matchAll(/(^|\s)@(\w+)/g)];
	const first = tags[0];
	const head = first ? text.slice(0, first.index) : text;
	const parts = [head];
	tags.forEach((m, n) => {
		const name = m[2] ?? "";
		const from = (m.index ?? 0) + m[0].length;
		const to = tags[n + 1]?.index ?? text.length;
		parts.push(tagProse(name, text.slice(from, to)));
	});
	return parts.join("\n").split("\n");
}

/**
 * @typedef {{ lang?: Lang, re: RegExp,
 *   read: (m: RegExpExecArray) => Suppression | "code" | null }} Directive
 */

/** @param {string} tool @param {number} [group] */
const suppresses =
	(tool, group = 1) =>
	(/** @type {RegExpExecArray} */ m) => ({
		tool,
		rules: splitRules(m[group] ?? ""),
	});
const readsAsCode = () => /** @type {const} */ ("code");

/** Each tool directive, in the order they are tried. @type {Directive[]} */
const DIRECTIVES = [
	{
		re: /^biome-ignore(?:-all|-start|-end)?\s+([^\s:(]+)/,
		read: suppresses("biome"),
	},
	{
		re: /^eslint-disable(?:-next-line|-line)?\b(.*?)(?:\s--\s.*)?$/,
		read: suppresses("eslint"),
	},
	{ re: /^eslint-enable\b/, read: readsAsCode },
	{
		re: /^@ts-(?:expect-error|ignore)\b:?\s*(TS\d+)?/,
		read: suppresses("typescript"),
	},
	{ re: /^@ts-nocheck\b()/, read: suppresses("typescript") },
	{
		re: /^(?:@ts-check\b|<reference\s|@vitest-environment\s|[#@]__PURE__)/,
		read: readsAsCode,
	},
	{
		re: /^Stryker\s+disable\s+(?:next-line\s+)?([^:]*)/i,
		read: suppresses("stryker"),
	},
	{ re: /^Stryker\s+restore\b/i, read: readsAsCode },
	{
		re: /^(?:full-sweep-only:|Unbuilt caller:\s*\S+(?=\s|$))(.*)$/,
		read: (m) => (barePointers(m[1] ?? "") ? "code" : null),
	},
	{ re: /^workflow-core hook shim:$/, read: readsAsCode },
	{
		re: /^(?:(?:c8|istanbul|v8)\s+ignore\b|pragma:\s*no\s*(?:cover|branch)\b)()/,
		read: suppresses("coverage"),
	},
	{
		re: /^prettier-ignore\b/,
		read: () => ({ tool: "prettier", rules: ["format"] }),
	},
	{
		lang: "sh",
		re: /^shellcheck\s.*?\bdisable=([\w,]+)/,
		read: suppresses("shellcheck"),
	},
	{ lang: "sh", re: /^shellcheck\s/, read: readsAsCode },
	{
		lang: "py",
		re: /^(?:(?:ruff|flake8):\s*)?noqa\b(?::\s*([\w, ]+))?/i,
		read: suppresses("ruff"),
	},
	{
		lang: "py",
		re: /^fmt:\s*(?:off|on|skip)\b/,
		read: () => ({ tool: "ruff", rules: ["format"] }),
	},
	{
		lang: "py",
		re: /^type:\s*ignore\b(?:\[([^\]]*)\])?/,
		read: suppresses("mypy"),
	},
	{
		lang: "py",
		re: /^pyright:\s*ignore\b(?:\[([^\]]*)\])?/,
		read: suppresses("pyright"),
	},
	{
		lang: "py",
		re: /^(?:type:|pyright:|-\*-\s*coding[:=]|vim?:.*coding[:=])/,
		read: readsAsCode,
	},
];

/**
 * A comment line's tool directive: a suppression naming its tool and rules,
 * `code` for a directive a tool reads and that suppresses nothing, or null.
 * @param {string} text the line, its marker off
 * @param {Lang} lang
 * @returns {Suppression | "code" | null}
 */
function directiveOf(text, lang) {
	const t = text.trim();
	for (const d of DIRECTIVES) {
		if (d.lang && d.lang !== lang) continue;
		const m = d.re.exec(t);
		if (m) return d.read(m);
	}
	return null;
}

/** @param {string} list */
const splitRules = (list) =>
	list
		.split(/[\s,]+/)
		.map((r) => r.trim())
		.filter(Boolean);

/**
 * Whether ruff's selector `entry` selects `code`: the same linter letters,
 * and digits the selector's open.
 * @param {string} entry
 * @param {string} rule
 */
function ruffSelects(entry, rule) {
	const selector = /^([A-Z]+)(\d*)$/.exec(entry);
	const parts = /^([A-Z]+)(\d+)$/.exec(rule);
	return Boolean(
		selector &&
			parts &&
			selector[1] === parts[1] &&
			(parts[2] ?? "").startsWith(selector[2] ?? ""),
	);
}

/**
 * Whether `rule` is on the tool's style-only list.
 * @param {Record<string, string[]>} list
 * @param {string} tool
 * @param {string} rule
 */
function styleOnly(list, tool, rule) {
	return (list[tool] ?? []).some(
		(entry) =>
			rule === entry ||
			(tool === "ruff"
				? ruffSelects(entry, rule)
				: rule.startsWith(`${entry}/`)),
	);
}

const POINTER =
	/^(?:(?:[\w.-]+\/[\w.-]+)?#\d+|ADR-\d{4}|RFC\d+(?:§[\d.]+)?|https?:\/\/(?:www\.rfc-editor\.org\/rfc\/|datatracker\.ietf\.org\/doc\/(?:html\/)?|tools\.ietf\.org\/html\/)rfc\d+(?:[#/?.]\S*)?)$/;

/**
 * Whether `text` is pointers alone: `#N`, `owner/repo#N`, `ADR-NNNN`, an RFC
 * or an RFC link, with no prose beside them (#5457).
 * @param {string} text
 */
function barePointers(text) {
	const tokens = text
		.replace(/^\(|\)?\.?$/g, "")
		.replace(/\bRFC (?=\d)/g, "RFC")
		.replace(/ ?§ ?/g, "§")
		.split(/[\s,;()]+|\band\b/)
		.filter(Boolean);
	return tokens.length > 0 && tokens.every((t) => POINTER.test(t));
}
const LICENCE = /SPDX-License-Identifier:|\bcopyright\b|©/i;
const DERIVATION = /\b(?:measured|guess)\b/i;
const ISSUE = /(?<![\w&])#\d+|\/[\w.-]+#\d+/;
const URL = /\bhttps?:\/\/\S/;

/**
 * The export a code line declares, or "".
 * @param {string} line
 * @param {Lang} lang
 */
function declaredName(line, lang) {
	const pattern = {
		js: /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\*?\s+([\w$]+)|class\s+([\w$]+)|(?:const|let|var)\s+([\w$]+))|^(?:module\.)?exports\.([\w$]+)\s*=/,
		py: /^(?:async\s+)?(?:def|class)\s+(\w+)|^(\w+)\s*(?::[^=]*)?=/,
		sh: /^(?:function\s+)?([\w-]+)\s*\(\s*\)|^function\s+([\w-]+)/,
	}[lang];
	const m = pattern.exec(line.trim());
	return m ? (m.slice(1).find(Boolean) ?? "") : "";
}

/**
 * Whether the unit is a contract doc on what the plugin ships (K4): on an
 * export the helper surface lists for the file, or the opening comment of a
 * file it ships whole.
 * @param {Unit} unit
 * @param {FileFacts} facts
 */
function onShippedExport(unit, facts) {
	if (unit.top && facts.shipped) return true;
	const name = declaredName(unit.owner || unit.next, facts.lang);
	return name !== "" && facts.exports.has(name);
}

/**
 * A unit's suppressions that name no rule or one off the style-only list,
 * and the lines left once every directive is taken out.
 * @param {Unit} unit
 * @param {FileFacts} facts
 * @returns {{ out: Breach[], prose: string[] }}
 */
function splitDirectives(unit, facts) {
	const lines =
		unit.jsdoc && facts.checkJs && facts.lang === "js"
			? jsdocProse(unit.lines)
			: unit.lines;
	/** @type {Breach[]} */
	const out = [];
	/** @type {string[]} */
	const prose = [];
	lines.forEach((raw, n) => {
		const line = raw.trim();
		const d = directiveOf(line, facts.lang);
		if (d === null) {
			if (line !== "") prose.push(line);
			return;
		}
		if (d === "code") return;
		const bad = d.rules.filter((r) => !styleOnly(facts.styleOnly, d.tool, r));
		if (d.rules.length > 0 && bad.length === 0) return;
		out.push({
			tag: "SUPPRESSION",
			line: unit.line + n,
			match: line.replace(/\s+/g, " "),
			why:
				d.rules.length === 0
					? `a ${d.tool} suppression naming no rule — name a rule on the style-only list (scripts/lib/style-only-rules.json), or fix the code`
					: `a ${d.tool} suppression of ${bad.join(", ")}, not on the style-only list (scripts/lib/style-only-rules.json) — fix the code instead`,
		});
	});
	return { out, prose };
}

/**
 * The breach a unit's prose makes, or null where it fits a permitted kind.
 * @param {Unit} unit
 * @param {string[]} prose
 * @param {FileFacts} facts
 * @returns {Breach | null}
 */
function proseBreach(unit, prose, facts) {
	const text = prose.join(" ").replace(/\s+/g, " ");
	const at = { line: unit.line, match: text };
	if (unit.top && LICENCE.test(text)) return null;
	if (barePointers(text)) {
		const missing = [...text.matchAll(/ADR-(\d{4})/g)]
			.map((m) => m[1] ?? "")
			.filter((n) => !facts.adrs.has(n));
		return missing.length === 0
			? null
			: {
					tag: "ADR-UNRESOLVED",
					...at,
					why: `ADR-${missing.join(", ADR-")} names no file under docs/adr/`,
				};
	}
	if (prose.length === 1 && DERIVATION.test(text) && ISSUE.test(text))
		return null;
	if (URL.test(text) || facts.deps?.test(text)) return null;
	if (onShippedExport(unit, facts)) return null;
	return { tag: "COMMENT", ...at, why: "fits no permitted comment kind" };
}

/**
 * @param {Unit} unit
 * @param {FileFacts} facts
 * @returns {Breach[]}
 */
function judgeUnit(unit, facts) {
	const { out, prose } = splitDirectives(unit, facts);
	const breach = prose.length > 0 ? proseBreach(unit, prose, facts) : null;
	return breach ? [...out, breach] : out;
}

/**
 * @param {string} source
 * @param {FileFacts} facts
 * @returns {Breach[]}
 */
function judgeSource(source, facts) {
	return UNITS[facts.lang](source).flatMap((u) => judgeUnit(u, facts));
}

/** @param {string[]} names */
function depsPattern(names) {
	const words = names.filter((n) => !n.startsWith("@types/"));
	if (words.length === 0) return null;
	const alts = [...words].sort((a, b) => b.length - a.length).map(escapeRe);
	return new RegExp(String.raw`\`(?:${alts.join("|")})\``);
}

module.exports = { CODE_FILE, depsPattern, judgeSource, langOf };
