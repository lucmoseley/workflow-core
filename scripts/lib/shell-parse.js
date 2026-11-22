const {
	QUOTED,
	hasExpansion,
	isBareSpan,
	readSentinels,
	literal,
	commandName,
	stepGitOptions,
	isGlobPattern,
	ASSIGNMENT_RE,
	WRAPPERS,
	afterSlash,
	scanWrapperFlag,
	splitEnvString,
	gitRunWords,
	dispatchingGhCall,
	nodeScriptArgs,
} = require("./shell-words.js");
const { expandTildeWord } = require("./home-path.js");
const {
	dirsAfter,
	moveDir,
	openChainScope,
	settleDirs,
	startDirs,
	stepDirs,
} = require("./shell-dirs.js");
const { endRun, trimEndRun } = require("./trim-run.js");
const { Lexer, SPACE } = require("./shell-lexer.js");
const gitAlias = require("./git-alias.js");
const {
	CONFIG_FILE_VARS,
	UNREAD_ALIAS,
	emptyAliasTable,
	isAliasKey,
	expandAlias,
	defineFromEnv,
	defineFromConfigEnvWord,
	defineFromConfigWord,
} = gitAlias;

const SCOPE_MARK = "\x02";
const SCOPE_OPEN = `${SCOPE_MARK}(`;
const SCOPE_CLOSE = `${SCOPE_MARK})`;

const OP_MARK = "\x05";

const JOIN = Object.freeze({
	NONE: "",
	AND: "a",
	OR: "o",
	SEMI: "s",
	PIPE: "p",
	BACKGROUND: "b",
	OPEN: "(",
	AFTER_CLOSE: ")",
});

/** @typedef {typeof JOIN[keyof typeof JOIN]} Join */

/** @type {readonly string[]} */
const JOIN_CODES = Object.values(JOIN);

/**
 * @param {string} code
 * @returns {code is Join}
 */
const isJoin = (code) => JOIN_CODES.includes(code);

const STAND_IN_BASE = 0xe0_00;

/** @param {string} chars */
function escapeShield(chars) {
	/** @param {number} at */
	const standIn = (at) => String.fromCharCode(STAND_IN_BASE + at);
	/** @param {string} text @param {(c: string) => string} swap */
	const swapPairs = (text, swap) =>
		text.replace(/\\[\s\S]/g, (pair) => `\\${swap(pair.charAt(1))}`);
	return {
		/** @param {string} text */
		shield: (text) =>
			swapPairs(text, (c) => {
				const at = chars.indexOf(c);
				return at < 0 ? c : standIn(at);
			}),
		/** @param {string} text */
		unshield: (text) =>
			swapPairs(
				text,
				(c) => chars.charAt(c.charCodeAt(0) - STAND_IN_BASE) || c,
			),
	};
}

const FLATTEN_SHIELD = escapeShield("()&|;<>");

// lucmoseley/mantahostels#2346
const GUARDED_HEADS = ["git", "gh"];

const IFS_SPLIT = /[ \t\n]+/;

const REDIRECT_RE = /^((?:\\.|[^\\<>])*)([<>].*)$/s;

/** @param {string} p */
const basename = (p) => p.slice(p.lastIndexOf("/") + 1);

/** @param {string} s */
const isResolvable = (s) => s !== "" && !hasExpansion(s) && !s.includes(QUOTED);

/** @param {InstanceType<typeof Lexer>} lx @param {string} text */
function maskText(lx, text) {
	lx.reset();
	text.split("\n").forEach((line, i) => {
		if (i) lx.lex("\n");
		lx.lex(line);
	});
	return lx.masked();
}

/** @param {string} text @param {boolean} [mark] @param {boolean} [ops] */
function flatten(text, mark = false, ops = false) {
	let inBackticks = false;
	/** @param {Join} code */
	const join = (code) => (ops ? `\n${OP_MARK}${code}` : "\n");
	const flat = FLATTEN_SHIELD.shield(text)
		.replace(/\\[\s\S]|`/g, (m) => {
			if (m !== "`") return m;
			inBackticks = !inBackticks;
			return inBackticks ? "$(" : ")";
		})
		.replace(/&&/g, join(JOIN.AND))
		.replace(/\|\|/g, join(JOIN.OR))
		.replace(/([<>])&/g, "$1\x03")
		.replace(/&>/g, "\x03>")
		.replace(/>\|/g, ">\x04")
		.replace(/[()]/g, (b) =>
			mark
				? `\n${SCOPE_MARK}${b}\n${ops && b === "(" ? `${OP_MARK}${JOIN.OPEN}` : ""}`
				: "\n",
		)
		.replace(/;/g, join(JOIN.SEMI))
		.replace(/\|&?/g, join(JOIN.PIPE))
		.replace(/&/g, join(JOIN.BACKGROUND))
		.replaceAll("\x03", "&")
		.replaceAll("\x04", "|");
	return `${FLATTEN_SHIELD.unshield(flat)}\n`;
}

/** @param {string} masked */
const indexOfFirstOr = (masked) => {
	for (const m of masked.matchAll(/\\[\s\S]|\|\|/g))
		if (m[0] === "||") return m.index;
	return -1;
};

/** @param {string} masked @returns {Join[]} */
function parseJoins(masked) {
	/** @type {Join} */
	let carry = JOIN.NONE;
	let closed = false;
	return flatten(masked, true, true)
		.split("\n")
		.map((line) => {
			const code = line.startsWith(OP_MARK) ? parseOpCode(line) : JOIN.NONE;
			const afterClose = closed && !code;
			const lineEnd = afterClose ? JOIN.AFTER_CLOSE : JOIN.NONE;
			closed = line === SCOPE_CLOSE;
			if (line.slice(code ? 2 : 0).trim() === "") {
				carry ||= code;
				return lineEnd || carry;
			}
			const joined = code || carry || lineEnd;
			carry = JOIN.NONE;
			return joined;
		});
}

/** @param {string} line @returns {Join} */
function parseOpCode(line) {
	const code = line.charAt(1);
	return isJoin(code) ? code : JOIN.SEMI;
}

/** @type {readonly Join[]} */
const CHAIN_HELD = [JOIN.AND, JOIN.PIPE, JOIN.OPEN, JOIN.AFTER_CLOSE];

/** @param {Join[]} joins @param {number} segIdx */
const isChainEnd = (joins, segIdx) =>
	!CHAIN_HELD.includes(joins[segIdx] ?? JOIN.NONE);

/**
 * @typedef {object} CommandWords
 * @property {string[]} words
 * @property {number} wi
 * @property {number} assignStart
 * @property {number} assignEnd
 * @property {RedirectEntry[]} redirs
 * @property {boolean} ran
 */

/**
 * @typedef {object} RedirectEntry
 * @property {string} fd
 * @property {string} op
 * @property {string} target
 */

/** @param {string[]} words @param {boolean} noRedirects */
function stripRedirects(words, noRedirects) {
	/** @type {RedirectEntry[]} */
	const redirs = [];
	if (!words.some((w) => /[<>]/.test(w)) || noRedirects)
		return { words, redirs };
	/** @type {string[]} */
	const out = [];
	let cond = isConditionalTail(words);
	let i = 0;
	while (i < words.length) {
		const w = words[i++] ?? "";
		if (w === "[[") cond = true;
		if (w === "]]") cond = false;
		if (!cond) i = cutRedirects(w, words, i, { out, redirs });
		else if (w) out.push(w);
	}
	return { words: out, redirs };
}

/** @param {string[]} words */
function isConditionalTail(words) {
	for (const w of words) {
		if (w === "[[") return false;
		if (w === "]]") return true;
	}
	return false;
}

const REDIRECT_OPS = [
	"&>>",
	"&>",
	">>",
	">|",
	">&",
	"<<<",
	"<<-",
	"<<",
	"<>",
	"<&",
];

/**
 * @param {string} word
 * @param {string[]} words
 * @param {number} start
 * @param {{ out: string[], redirs: RedirectEntry[] }} acc
 */
function cutRedirects(word, words, start, { out, redirs }) {
	let w = word;
	let i = start;
	while (w) {
		const m = REDIRECT_RE.exec(w);
		if (!m) {
			out.push(w);
			break;
		}
		const { fd, op, rest } = parseOperator(m[1] ?? "", m[2] ?? "", out);
		const t = parseTarget(rest, words, i);
		if (!t) return words.length;
		redirs.push({ fd, op, target: t.target });
		w = t.w;
		i = t.next;
	}
	return i;
}

/** @param {string} before @param {string} from @param {string[]} out */
function parseOperator(before, from, out) {
	let pre = before;
	let rest = from;
	let fd = "";
	if (pre.endsWith("&") && !pre.endsWith("\\&") && rest.startsWith(">")) {
		pre = pre.slice(0, -1);
		rest = `&${rest}`;
		fd = "&";
	}
	if (!fd && /^(?:[0-9]+|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(pre)) fd = pre;
	else if (pre) out.push(pre);
	const op = REDIRECT_OPS.find((o) => rest.startsWith(o)) ?? rest.charAt(0);
	return { fd, op, rest: rest.slice(op.length) };
}

/**
 * @param {string} rest
 * @param {string[]} words
 * @param {number} i
 * @returns {{ target: string, w: string, next: number } | null}
 */
function parseTarget(rest, words, i) {
	if (rest) {
		const r = REDIRECT_RE.exec(rest);
		if (!r) return { target: rest, w: "", next: i };
		const target = r[1] ?? "";
		const w = rest.slice(target.length);
		if (target.endsWith("&") && w.startsWith(">"))
			return { target: target.slice(0, -1), w: `&${w}`, next: i };
		return { target, w, next: i };
	}
	if (i >= words.length) return null;
	const target = words[i] ?? "";
	if ((target === "<" || target === ">") && i + 1 === words.length) return null;
	return { target, w: "", next: i + 1 };
}

/**
 * @param {string} segment
 * @param {{ bare?: boolean, noRedirects?: boolean }} [opts]
 * @returns {CommandWords}
 */
function commandWords(segment, { bare = false, noRedirects = false } = {}) {
	const line = segment.split("\n")[0] ?? "";
	const { words, redirs } = stripRedirects(
		line.split(IFS_SPLIT).filter(Boolean),
		noRedirects,
	);
	if (words.length === 0)
		return { words, wi: 0, assignStart: 0, assignEnd: 0, redirs, ran: false };
	const assignStart = bare ? 0 : skipReserved(words, 0);
	let wi = assignStart;
	while (wi < words.length && ASSIGNMENT_RE.test(words[wi] ?? "")) wi++;
	const assignEnd = wi;
	if (!bare) wi = skipExec(words, wi);
	return { words, wi, assignStart, assignEnd, redirs, ran: wi < words.length };
}

const RESERVED_WORDS = [
	"{",
	"!",
	"if",
	"then",
	"else",
	"elif",
	"while",
	"until",
	"do",
	"coproc",
];

/** @param {string[]} words @param {number} start */
function skipReserved(words, start) {
	let wi = start;
	while (wi < words.length) {
		const w = words[wi] ?? "";
		if (w === "time") {
			if (words[wi + 1] === "-p") wi++;
			if (words[wi + 1] === "--") wi++;
		} else if (!RESERVED_WORDS.includes(w)) break;
		wi++;
	}
	return wi;
}

/** @param {string[]} words @param {number} start */
function skipExec(words, start) {
	if (words[start] !== "exec") return start;
	let wi = start + 1;
	while ((words[wi] ?? "").startsWith("-")) {
		if ((words[wi] ?? "").endsWith("a")) wi++;
		wi++;
	}
	return wi;
}

/** @param {string} p */
function normAbs(p) {
	/** @type {string[]} */
	const out = [];
	for (const part of (p.split("\n")[0] ?? "").split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return `/${out.join("/")}`;
}

/** @param {string} kind */
const isWriteRedirect = (kind) =>
	["truncate", "clobber", "append", "read-write"].includes(kind);

/**
 * @typedef {object} Parsed
 * @property {string} subject
 * @property {string[]} spans
 * @property {string} masked
 * @property {number[]} heredocLines
 * @property {string[]} segments
 * @property {number} conditional
 * @property {Join[]} joins
 * @property {boolean[]} lifted
 */

/** @param {string} subject @param {string[]} [spans] @returns {Parsed} */
function parseCommand(subject, spans = []) {
	const { masked, heredocLines } = maskSubject(subject, spans);
	const orAt = indexOfFirstOr(masked);
	const before =
		orAt >= 0
			? (flatten(masked.slice(0, orAt), true).match(/\n/g)?.length ?? 0)
			: -1;
	/** @type {string[]} */
	const segments = [];
	/** @type {Join[]} */
	const joins = [];
	/** @type {boolean[]} */
	const lifted = [];
	const lineJoins = parseJoins(masked);
	let conditional = -1;
	flatSegments(masked).forEach((segment, i) => {
		if (i === before) conditional = segments.length;
		const own = withLifted(segment, spans);
		segments.push(...own);
		const join = lineJoins[i];
		if (join === undefined) throw new Error("a segment with no join");
		const subs = own.slice(0, -1);
		joins.push(...subs.map(() => JOIN.OPEN), join);
		lifted.push(...subs.map(() => true), false);
	});
	if (before >= 0 && conditional < 0) conditional = segments.length;
	return {
		subject,
		spans,
		masked,
		heredocLines,
		segments,
		conditional,
		joins,
		lifted,
	};
}

/** @param {string} subject @param {string[]} spans */
function maskSubject(subject, spans) {
	const start = spans.length;
	const lx = new Lexer(spans);
	const { commandLines, heredocLines } = readCommandLines(subject, lx);
	spans.length = start;
	const masked = trimEndRun(
		joinLogicalLines(commandLines, lx, spans).join("\n"),
		"\n",
	);
	return { masked, heredocLines };
}

/** @param {string} masked */
const flatSegments = (masked) =>
	trimEndRun(flatten(masked, true), "\n").split("\n");

/** @param {string} segment @param {string[]} spans */
const withLifted = (segment, spans) => [
	...liftSubstitutions(segment, spans),
	segment,
];

/** @param {string} segment @param {string[]} spans @returns {string[]} */
function liftSubstitutions(segment, spans) {
	/** @type {string[]} */
	const lifted = [];
	readSentinels(segment, (_lit, idx) => {
		const span = idx === null ? undefined : spans[idx];
		if (span === undefined) return { text: "", stepPast: true };
		for (const inner of quotedSubstitutions(span)) {
			const { masked } = maskSubject(inner, spans);
			lifted.push(SCOPE_OPEN);
			for (const seg of flatSegments(masked))
				lifted.push(...withLifted(seg, spans));
			lifted.push(SCOPE_CLOSE);
		}
		return { text: "", stepPast: true };
	});
	return lifted;
}

/** @param {string} span */
function quotedSubstitutions(span) {
	/** @type {string[]} */
	const found = [];
	if (!span.startsWith('"')) return found;
	let i = 1;
	while (i > 0 && i < span.length) {
		const { next, text } = scanSubstitution(span, i);
		if (text !== null) found.push(text);
		i = next;
	}
	return found;
}

/**
 * @param {string} span
 * @param {number} i
 * @returns {{ next: number, text: string | null }}
 */
function scanSubstitution(span, i) {
	const c = span.charAt(i);
	if (c === "\\") return { next: i + 2, text: null };
	if (c === "`") {
		const end = backtickEnd(span, i + 1);
		if (end < 0) return { next: -1, text: null };
		const text = span.slice(i + 1, end).replace(/\\([$`\\"])/g, "$1");
		return { next: end + 1, text };
	}
	if (!span.startsWith("$(", i)) return { next: i + 1, text: null };
	const end = Lexer.substitutionEnd(span, i + 2);
	if (end < 0) return { next: -1, text: null };
	const isArith = span.charAt(i + 2) === "(";
	return { next: end, text: isArith ? null : span.slice(i + 2, end - 1) };
}

/** @param {string} text @param {number} from */
function backtickEnd(text, from) {
	for (let j = from; j < text.length; j++) {
		const c = text.charAt(j);
		if (c === "`") return j;
		if (c === "\\") j++;
	}
	return -1;
}

/** @param {string} subject @param {InstanceType<typeof Lexer>} lx */
function readCommandLines(subject, lx) {
	/** @type {number[]} */
	const heredocLines = [];
	/** @type {string[]} */
	const commandLines = [];
	let term = "";
	let held = "";
	subject.split("\n").forEach((raw, idx) => {
		if (term) {
			heredocLines.push(idx);
			if (raw === term || raw === `${term};`) term = "";
			return;
		}
		const line = held + raw;
		held = "";
		if (isLineContinued(lx, line)) {
			held = line.slice(0, -1);
			return;
		}
		lx.lex("\n");
		term = parseHeredocTerm(lx.out, line);
		if (term) lx.reset();
		commandLines.push(line);
	});
	if (held) commandLines.push(held);
	return { commandLines, heredocLines };
}

/** @param {InstanceType<typeof Lexer>} lx @param {string} line */
function isLineContinued(lx, line) {
	const saved = hasOddTrailingBackslashes(line) ? lx.save() : null;
	lx.out = "";
	lx.lex(line);
	if (!lx.escaped || lx.frames.endsWith("E")) return false;
	if (saved) lx.load(saved);
	return true;
}

/** @param {string} line */
const hasOddTrailingBackslashes = (line) => endRun(line, "\\").length % 2 === 1;

/** @param {string} mask @param {string} line */
function parseHeredocTerm(mask, line) {
	const opener = /<<-?[ \t\n\v\f\r]*\\?([A-Za-z_][A-Za-z0-9_]*)/.exec(mask);
	const quoted = mask.includes("<<")
		? /<<-?[ \t\n\v\f\r]*['"]([A-Za-z_][A-Za-z0-9_]*)/.exec(line)
		: null;
	return opener?.[1] ?? quoted?.[1] ?? "";
}

/**
 * @param {string[]} commandLines
 * @param {InstanceType<typeof Lexer>} lx
 * @param {string[]} spans
 */
function joinLogicalLines(commandLines, lx, spans) {
	/** @type {string[]} */
	const kept = [];
	/** @type {string[]} */
	let pending = [];
	const keepPerLine = () => {
		for (const line of pending) kept.push(maskText(lx, line));
		pending = [];
		lx.reset();
	};
	let heldAt = "";
	let held = false;
	lx.reset();
	for (const line of commandLines) {
		if (pending.length > 0) {
			const at = `${lx.opens}${lx.frames ? "open" : ""}`;
			if (heldAt !== at) {
				heldAt = at;
				held = isJoinHeld(lx, spans);
			}
			if (!held && isCommandAbsorbed(line, spans)) {
				pending.push(line);
				keepPerLine();
				continue;
			}
			lx.lex("\n");
		}
		pending.push(line);
		lx.lex(line);
		if (lx.open()) continue;
		kept.push(lx.out);
		pending = [];
		lx.reset();
	}
	keepPerLine();
	return kept;
}

/** @param {string} line @param {string[]} spans */
function isCommandAbsorbed(line, spans) {
	const masked = maskText(new Lexer(spans), line);
	for (const seg of flatten(masked).split("\n")) {
		const { words, wi, ran } = commandWords(seg, { bare: true });
		if (ran && GUARDED_HEADS.includes(basename(words[wi] ?? ""))) return true;
	}
	return false;
}

/** @param {InstanceType<typeof Lexer>} lx */
function isMessageOpen(lx) {
	if (!lx.frames) return false;
	const lines = flatten(lx.prefix).split("\n");
	const last = lines.at(-2) ?? "";
	const { words, wi, ran } = commandWords(last);
	if (!ran) return false;
	const word = (words.at(-1) ?? "").replace(/[=]$/, "");
	if (word === "-m" || word === "--message") return true;
	return (
		basename(words[wi] ?? "") === "gh" &&
		["-b", "--body", "-t", "--title"].includes(word)
	);
}

/** @param {InstanceType<typeof Lexer>} lx @param {string[]} spans */
const isJoinHeld = (lx, spans) => isMessageOpen(lx) || isScriptOpen(lx, spans);

/** @param {InstanceType<typeof Lexer>} lx @param {string[]} spans */
function isScriptOpen(lx, spans) {
	if (!/[ \t]$/.test(lx.prefix)) return false;
	const lines = flatten(lx.prefix).split("\n");
	const { words, wi, ran } = commandWords(lines.at(-2) ?? "");
	return ran && isScriptNext(words.slice(wi), spans);
}

/** @param {string} segment */
function unmask(segment) {
	const { out, rest } = readSentinels(segment, (lit, idx) => ({
		text: `${lit}"…"`,
		stepPast: idx !== null,
	}));
	return (out + rest).replace(/^[ \t\n\v\f\r]+/, "");
}

/** @param {string} text @param {string[]} spans */
function asWritten(text, spans) {
	const { out, rest } = readSentinels(text, (lit, idx) => {
		const span = idx === null ? undefined : spans[idx];
		if (span === undefined) return { text: `${lit}<quoted>`, stepPast: true };
		const close = isBareSpan(span) ? "" : span.charAt(0);
		return { text: lit + span + close, stepPast: true };
	});
	return out + rest;
}

/**
 * @typedef {object} Scope
 * @property {string[]} spans
 * @property {Map<string, string>} locals
 * @property {Set<string>} dead
 * @property {Set<string>} exported
 * @property {Map<string, number>} harvested
 * @property {Record<string, string | undefined>} vars
 * @property {string} subject
 * @property {number} conditional
 * @property {boolean} emptyUnset
 * @property {string[]} emptyNames
 */

/** @param {string} text @param {Scope} scope @returns {string | null} */
function expandVars(text, scope) {
	if (text.includes("$(") || text.includes("`")) return null;
	let s = text;
	let out = "";
	while (s.includes("$")) {
		const at = s.indexOf("$");
		out += s.slice(0, at);
		const ref = parseVarRef(s.slice(at + 1));
		if (!ref) return null;
		const val = lookupVar(ref.name, scope);
		if (val === null) return null;
		out += val;
		s = ref.rest;
	}
	return out + s;
}

/** @param {string} s */
function parseVarRef(s) {
	if (s.startsWith("{")) {
		const close = s.indexOf("}");
		if (close < 0) return null;
		return { name: s.slice(1, close), rest: s.slice(close + 1) };
	}
	const m = NAME_PREFIX_RE.exec(s);
	if (!m) return null;
	return { name: m[0], rest: s.slice(m[0].length) };
}

const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const NAME_RE = new RegExp(`^${NAME}$`);
const NAME_PREFIX_RE = new RegExp(`^${NAME}`);

/** @param {string} name @param {Scope} scope */
function lookupVar(name, scope) {
	if (!NAME_RE.test(name) || scope.dead.has(name)) return null;
	let val = scope.locals.get(name);
	if (val === "" && isProvablyEmpty(name, 1, scope)) return "";
	if (!scope.locals.has(name)) {
		val = scope.vars[name];
		if (val === undefined) return isProvablyEmpty(name, 0, scope) ? "" : null;
	}
	if (val === undefined || val === "" || /[$`'";|&()<>*?\s]/.test(val))
		return null;
	return val;
}

const SOURCING_RE =
	/(?:(?:^|[;&|(]|then|do|else)[ \t\n\v\f\r]*|\n[ \t\v\f\r]*)(source|\.|eval)[ \t\n\v\f\r]/;

/** @param {string} name @param {number} allowed @param {Scope} scope */
function isProvablyEmpty(name, allowed, scope) {
	const { subject } = scope;
	if (!scope.emptyUnset || scope.conditional >= 0) return false;
	if (SOURCING_RE.test(subject)) return false;
	if (bareMentions(name, subject) > allowed) return false;
	if (!allowed) scope.emptyNames.push(name);
	return true;
}

/** @param {string} name @param {string} subject */
function bareMentions(name, subject) {
	let mentions = 0;
	for (
		let at = subject.indexOf(name);
		at >= 0;
		at = subject.indexOf(name, at + name.length)
	) {
		const before = subject.slice(0, at);
		const after = subject.slice(at + name.length);
		if (/[A-Za-z0-9_]$/.test(before) || /^[A-Za-z0-9_]/.test(after)) continue;
		if (before.endsWith("$") || before.endsWith("${")) continue;
		mentions++;
	}
	return mentions;
}

/**
 * @param {string} word
 * @param {Scope} scope
 * @returns {{ path: string } | { empty: true } | null}
 */
function pathArg(word, scope) {
	scope.emptyNames = [];
	const raw = expandTilde(word, scope);
	if (raw === null) return null;
	if (isResolvable(raw)) return { path: raw };
	if (!raw) return null;
	const out = expandMasked(raw, scope);
	if (out === null) return null;
	if (out) return isResolvable(out) ? { path: out } : null;
	return raw.includes(QUOTED) ? { empty: true } : null;
}

/** @param {string} word @param {Scope} scope */
function expandTilde(word, scope) {
	if (!word.startsWith("~")) return word;
	return expandTildeWord(word, expandVars("$HOME", scope));
}

/** @param {string} raw @param {Scope} scope */
function expandMasked(raw, scope) {
	let ok = true;
	const { out, rest } = readSentinels(raw, (lit, idx) => {
		const recorded = idx === null ? undefined : scope.spans[idx];
		const head = ok && recorded !== undefined ? expandVars(lit, scope) : null;
		const span =
			head === null || recorded === undefined
				? null
				: expandSpan(recorded, scope);
		if (span === null) ok = false;
		return { text: `${head}${span}`, stepPast: true };
	});
	const tail = ok ? expandVars(rest, scope) : null;
	return tail === null ? null : out + tail;
}

/** @param {string} recorded @param {Scope} scope */
function expandSpan(recorded, scope) {
	if (isBareSpan(recorded)) return recorded;
	const span = recorded.slice(1);
	if (recorded.charAt(0) === '"') return expandVars(span, scope);
	if (recorded.charAt(0) !== "'" || hasExpansion(span)) return null;
	return span;
}

/** @param {string} word @param {Scope} scope */
function resolveWord(word, scope) {
	const r = pathArg(word, scope);
	return r && "path" in r ? r.path : null;
}

/**
 * @typedef {object} Redirect
 * @property {string} fd
 * @property {string} kind
 * @property {string} target
 * @property {string} path
 */

/**
 * @typedef {object} WriteTarget
 * @property {"write" | "move-source" | "delete"} mode
 * @property {string} route
 * @property {string} target
 * @property {string} path
 */

/**
 * @typedef {object} Command
 * @property {string} segment
 * @property {string[]} words
 * @property {string[]} leading
 * @property {string} cwd
 * @property {import("./shell-dirs.js").Dirs} cwds
 * @property {() => [CommandRun, ...CommandRun[]]} runs
 * @property {() => Redirect[]} redirects
 * @property {(words?: string[], cwd?: string) => WriteTarget[]} writeTargets
 * @property {(word: string) => string | null} resolveWord
 * @property {(name: string) => boolean} assigned
 */

/**
 * @typedef {Unwrapped & {
 *   dirs: () => import("./shell-dirs.js").Dirs }} CommandRun
 */

/**
 * @typedef {object} WalkPorts
 * @property {string | undefined} cwd
 * @property {string} fallbackCwd
 * @property {Record<string, string | undefined>} vars
 * @property {(path: string) => boolean} isDir
 * @property {boolean} [bareRedirects]
 */

/** @type {WalkPorts} */
const TEXT_ONLY_PORTS = Object.freeze({
	cwd: undefined,
	fallbackCwd: "/",
	vars: {},
	isDir: () => false,
});

/** @typedef {Map<string, string | null>} GitEnv */

/**
 * @typedef {object} Walk
 * @property {Parsed} parsed
 * @property {Scope} scope
 * @property {import("./shell-dirs.js").DirsState} dirs
 * @property {number} cdAt
 * @property {string[]} cwdNames
 * @property {string} cwdLost
 * @property {boolean} aliasWritten
 * @property {GitEnv} gitEnv
 * @property {{ dirs: import("./shell-dirs.js").DirsState, names: string[],
 *   noRedirects: boolean, gitEnv: GitEnv, vars: ScopeVars }[]} stack
 * @property {boolean} noRedirects
 * @property {string} arPrev
 * @property {string} arLast
 */

/**
 * @param {Parsed} parsed
 * @param {Record<string, string | undefined>} vars
 * @param {string} cwd
 * @param {boolean} emptyUnset
 * @returns {Walk}
 */
const newWalk = (parsed, vars, cwd, emptyUnset) => ({
	parsed,
	scope: {
		spans: parsed.spans,
		locals: new Map(),
		dead: new Set(),
		exported: new Set(),
		harvested: new Map(),
		vars,
		subject: parsed.subject,
		conditional: parsed.conditional,
		emptyUnset,
		emptyNames: [],
	},
	dirs: startDirs([cwd]),
	cdAt: -1,
	cwdNames: [],
	cwdLost: "",
	aliasWritten: false,
	gitEnv: new Map(),
	stack: [],
	noRedirects: false,
	arPrev: "",
	arLast: "",
});

/**
 * @param {Walk} walk
 * @param {(segment: string, cw: CommandWords, segIdx: number) => void} fn
 */
function eachSegment(walk, fn) {
	walk.parsed.segments.forEach((segment, segIdx) => {
		if (arithScope(walk, segment)) return;
		const cw = commandWords(segment, { noRedirects: walk.noRedirects });
		if (!runsApart(walk.parsed, segIdx)) harvestSegment(walk, cw, segIdx);
		fn(segment, cw, segIdx);
	});
}

/** @param {Walk} walk @param {CommandWords} cw @param {number} segIdx */
function harvestSegment(walk, cw, segIdx) {
	if (cw.ran)
		harvestExport(walk.scope, walk.parsed, cw.words.slice(cw.wi), segIdx);
	else
		harvest(walk.scope, walk.parsed, cw.words.slice(0, cw.assignEnd), segIdx);
}

/** @param {Walk} walk @param {string} segment */
function arithScope(walk, segment) {
	const isOpen = segment === SCOPE_OPEN;
	const isClose = segment === SCOPE_CLOSE;
	if (isOpen) openScope(walk);
	else if (isClose) closeScope(walk);
	else if (segment !== "") walk.arLast = "";
	else if (walk.arLast === "open") walk.arLast = "open-empty";
	walk.arPrev = segment;
	return isOpen || isClose;
}

/** @typedef {Pick<Scope, "locals" | "dead" | "exported">} ScopeVars */

/** @param {Scope} scope @returns {ScopeVars} */
const copyVars = (scope) => ({
	locals: new Map(scope.locals),
	dead: new Set(scope.dead),
	exported: new Set(scope.exported),
});

/** @param {Walk} walk */
function openScope(walk) {
	const { dirs, cwdNames: names, noRedirects, gitEnv, scope } = walk;
	walk.stack.push({ dirs, names, noRedirects, gitEnv, vars: copyVars(scope) });
	walk.dirs = openChainScope(dirs);
	if (walk.arLast === "open-empty") {
		walk.noRedirects = true;
		walk.arLast = "";
		return;
	}
	if (walk.arPrev.endsWith("$")) walk.noRedirects = false;
	walk.arLast = "open";
}

/** @param {Walk} walk */
function closeScope(walk) {
	const back = walk.stack.pop();
	if (back) {
		walk.dirs = back.dirs;
		walk.cwdNames = back.names;
		walk.noRedirects = back.noRedirects;
		walk.gitEnv = back.gitEnv;
		Object.assign(walk.scope, back.vars);
	}
	walk.arLast = "";
}

const ASSIGNMENT = new RegExp(`^(${NAME})=(.*)$`, "s");

/**
 * @param {Scope} scope
 * @param {Parsed} parsed
 * @param {string[]} words
 * @param {number} segIdx
 */
function harvest(scope, { conditional }, words, segIdx) {
	const skipped = conditional >= 0 && segIdx >= conditional;
	for (const w of words) {
		const m = ASSIGNMENT.exec(w);
		if (!m) continue;
		const val = skipped ? null : assignedValue(m[2] ?? "", scope);
		recordAssignment(scope, m[1] ?? "", val);
		countHarvested(scope, m[1] ?? "");
	}
}

/** @param {Scope} scope @param {string} name */
const countHarvested = (scope, name) =>
	scope.harvested.set(name, (scope.harvested.get(name) ?? 0) + 1);

/**
 * @param {Scope} scope
 * @param {Parsed} parsed
 * @param {string[]} own
 * @param {number} segIdx
 */
function harvestExport(scope, parsed, [head = "", ...rest], segIdx) {
	const kind = exportKind(head, rest);
	if (kind === null) return;
	for (const { w, text, name } of exportArgs(rest, parsed.spans)) {
		if (!NAME_RE.test(name)) continue;
		if (ASSIGNMENT.exec(w)?.[1] === name && head !== "unset")
			harvest(scope, parsed, [w], segIdx);
		else {
			if (head === "unset" || text !== name)
				recordAssignment(scope, name, null);
			countHarvested(scope, name);
		}
		if (kind === "export") scope.exported.add(name);
		else scope.exported.delete(name);
	}
}

/**
 * @param {Walk} walk
 * @param {string[]} leading
 * @param {number} segIdx
 * @returns {Map<string, Scope>}
 */
function leadingScopes(walk, leading, segIdx) {
	/** @type {Map<string, Scope>} */
	const out = new Map();
	leading.forEach((w, i) => {
		const name = ASSIGNMENT.exec(w)?.[1];
		if (name === undefined) return;
		const scope = {
			...walk.scope,
			...copyVars(walk.scope),
			harvested: new Map(walk.scope.harvested),
		};
		harvest(scope, walk.parsed, leading.slice(0, i), segIdx);
		out.set(name, scope);
	});
	return out;
}

/**
 * @param {Walk} walk
 * @param {string[]} words
 * @returns {import("./shell-dirs.js").Resolved}
 */
function moveCwd(walk, words) {
	const [head = "", arg] = words;
	if (losesCwd(head, arg)) {
		loseCwd(walk, words);
		return null;
	}
	const r = pathArg(arg ?? "", walk.scope);
	const names = walk.scope.emptyNames;
	if (r && "empty" in r) {
		walk.cwdNames = [...walk.cwdNames, ...names];
		return r;
	}
	if (!r || r.path.startsWith("-")) {
		loseCwd(walk, words);
		return null;
	}
	walk.cwdNames = r.path.startsWith("/")
		? [...names]
		: [...walk.cwdNames, ...names];
	return r;
}

/** @param {string} head @param {string | undefined} arg */
const movesCwd = (head, arg) => head === "cd" || losesCwd(head, arg);

/** @param {string} head @param {string | undefined} arg */
const losesCwd = (head, arg) =>
	head === "pushd" ||
	head === "popd" ||
	((head === "builtin" || head === "command") && arg === "cd");

/** @param {Walk} walk @param {string[]} words */
function loseCwd(walk, words) {
	walk.cwdNames = [];
	walk.cwdLost = words.join(" ");
}

/** @param {Walk} walk @param {string} word */
function absolutePath(walk, word) {
	return absoluteIn(cwdOf(walk), word, walk.scope);
}

/** @param {string} cwd @param {string} word @param {Scope} scope */
function absoluteIn(cwd, word, scope) {
	const p = resolveWord(word, scope);
	if (!p) return "";
	if (p.startsWith("/")) return normAbs(p);
	return cwd ? normAbs(`${cwd}/${p}`) : "";
}

/**
 * @param {Parsed} parsed
 * @param {(cmd: Command) => void} fn
 * @param {WalkPorts} ports
 */
function walkCommands(parsed, fn, ports) {
	const seed =
		typeof ports.cwd === "string" && ports.cwd.startsWith("/")
			? ports.cwd
			: ports.fallbackCwd;
	const walk = newWalk(parsed, ports.vars, seed, false);
	const { scope } = walk;
	/** @param {string} word */
	const abs = (word) => absolutePath(walk, word);
	eachSegment(
		walk,
		(segment, { words, wi, assignEnd, redirs, ran }, segIdx) => {
			settleCwdDoubt(walk, segIdx);
			if (!ran && !(ports.bareRedirects && redirs.length > 0)) return;
			const own = ran ? words.slice(wi) : [];
			const leading = words.slice(0, assignEnd);
			const redirects = () => readRedirects(redirs, scope, abs);
			/** @param {string} cwd */
			const at = (cwd) => (/** @type {string} */ word) =>
				absoluteIn(cwd, word, scope);
			fn({
				segment,
				words: own,
				leading,
				cwd: cwdOf(walk),
				cwds: walk.dirs.dirs,
				runs: commandRuns(own, walk.dirs.dirs, {
					scope,
					isDir: ports.isDir,
				}),
				redirects,
				writeTargets: (w = own, cwd = cwdOf(walk)) =>
					writeTargets(w, readRedirects(redirs, scope, at(cwd)), {
						spans: scope.spans,
						resolveAbs: at(cwd),
						resolve: (word) => resolveWord(word, scope),
						isDir: ports.isDir,
					}),
				resolveWord: (word) => resolveWord(word, scope),
				assigned: (name) => scope.locals.has(name),
			});
			if (ran) stepCwd(walk, own, segIdx, ports.isDir);
		},
	);
}

/**
 * @param {string[]} words
 * @param {import("./shell-dirs.js").Dirs} cwds
 * @param {{ scope: Scope, isDir: (path: string) => boolean }} at
 * @returns {() => [CommandRun, ...CommandRun[]]}
 */
function commandRuns(words, cwds, { scope, isDir }) {
	/** @type {[CommandRun, ...CommandRun[]] | undefined} */
	let runs;
	/** @param {Unwrapped} run @returns {CommandRun} */
	const withDirs = (run) => {
		/** @type {import("./shell-dirs.js").Dirs | undefined} */
		let dirs;
		return {
			...run,
			dirs: () => {
				dirs ??= runCwd(cwds, run.chdirs, scope, isDir);
				return dirs;
			},
		};
	};
	return () => {
		if (runs) return runs;
		const [first, ...later] = unwrap(words, scope.spans);
		runs = [withDirs(first), ...later.map(withDirs)];
		return runs;
	};
}

/**
 * @typedef {import("./shell-words.js").Chdir} Chdir
 */

/**
 * @typedef {object} ScriptCommand
 * @property {string[]} words
 * @property {string[]} leading
 * @property {Chdir[]} chdirs
 * @property {string[]} unread
 */

/**
 * @typedef {object} ScriptAt
 * @property {Parsed} parsed
 * @property {number} segIdx
 * @property {string[]} spans
 */

/**
 * @typedef {object} ScriptState
 * @property {Chdir[]} chdirs
 * @property {{ depth: number }[]} pending
 * @property {boolean} subshellOpened
 * @property {string[]} exports
 * @property {Map<string, string>} locals
 * @property {string[]} lost
 * @property {string[]} unread
 * @property {number} cdAt
 */

/** @param {string} script @param {string[]} spans @returns {ScriptCommand[]} */
function parseScript(script, spans) {
	const parsed = parseCommand(script, spans);
	/** @type {ScriptCommand[]} */
	const out = [];
	/** @type {ScriptState} */
	let state = {
		chdirs: [],
		pending: [],
		subshellOpened: false,
		exports: [],
		locals: new Map(),
		lost: [],
		unread: [],
		cdAt: -1,
	};
	/** @type {ScriptState[]} */
	const stack = [];
	parsed.segments.forEach((segment, segIdx) => {
		if (segment === SCOPE_OPEN) {
			stack.push(state);
			state = { ...openChainScope(state), subshellOpened: true };
			return;
		}
		if (segment === SCOPE_CLOSE) {
			const outer = stack.pop();
			if (outer)
				state = {
					...outer,
					lost: settleLost(outer.lost, changedNames(state, outer), false),
				};
			return;
		}
		const ends = chainEndDepth(parsed, segIdx);
		if (ends !== undefined) state = settleScriptChain(state, ends);
		const cw = commandWords(segment);
		const assigned = cw.words.slice(cw.assignStart, cw.assignEnd);
		if (cw.ran)
			out.push({
				words: cw.words.slice(cw.wi),
				leading: [...state.exports, ...assigned],
				chdirs: state.chdirs,
				unread: state.unread,
			});
		const where = { parsed, segIdx, spans };
		state = cw.ran
			? stepScript(state, cw, where)
			: assignAlone(state, cw.words, assigned, where);
	});
	return out;
}

/** @param {ScriptState} state @param {number} depth @returns {ScriptState} */
function settleScriptChain(state, depth) {
	if (!state.pending.some((p) => p.depth >= depth)) return state;
	const last = state.chdirs.at(-1);
	if (!last) throw new Error("a -c string's && chain is open with no cd");
	/** @type {Chdir} */
	const settled = { ...last, settles: Math.min(last.settles ?? depth, depth) };
	return {
		...state,
		chdirs: [...state.chdirs.slice(0, -1), settled],
		pending: state.pending.filter((p) => p.depth < depth),
	};
}

/**
 * @param {ScriptState} state
 * @param {string[]} words
 * @param {string[]} assigned
 * @param {ScriptAt} where
 * @returns {ScriptState}
 */
function assignAlone(state, words, assigned, where) {
	const { spans } = where;
	const locals = new Map(state.locals);
	let { exports } = state;
	for (const w of assigned) {
		const name = assignedName(w, spans);
		locals.set(name, w);
		if (exports.some((e) => assignedName(e, spans) === name))
			exports = [...withoutName(exports, name, spans), w];
	}
	const { set, lostTo } = assignedNames(
		assigned.map((w) => literal(w, spans).text),
		false,
	);
	const lost = settleLost(
		settleLost(state.lost, set, isSureAssignment(where)),
		lostTo,
		false,
	);
	return markScriptUnread(
		{ ...state, locals, exports, lost },
		words,
		true,
		spans,
	);
}

const BARE_NAME_RE = /(?<![\w$])(?<!\$\{)[A-Za-z_]\w*/g;

/** @param {string[]} texts @param {boolean} empties */
function assignedNames(texts, empties) {
	/** @type {string[]} */
	const set = [];
	/** @type {string[]} */
	const lostTo = [];
	for (const t of texts) {
		const name = (t.split("=", 1)[0] ?? "").replace(/\+$/, "");
		if (empties || /^[^=]*\+=/.test(t)) lostTo.push(name);
		else if (t.includes("=")) set.push(name);
	}
	return { set, lostTo };
}

/**
 * @param {ScriptState} inner
 * @param {ScriptState} outer
 */
const changedNames = (inner, outer) => [
	...inner.lost,
	...[...inner.locals].flatMap(([name, w]) =>
		outer.locals.get(name) === w ? [] : [name],
	),
];

/** @param {Pick<ScriptAt, "parsed" | "segIdx">} where */
const isSureAssignment = ({ parsed, segIdx }) =>
	isSureMove(parsed, segIdx, []) && !runsApart(parsed, segIdx);

/** @param {string[]} lost @param {string[]} names @param {boolean} sure */
const settleLost = (lost, names, sure) =>
	sure
		? lost.filter((n) => !names.includes(n))
		: [...lost, ...names.filter((n) => !lost.includes(n))];

/**
 * @param {ScriptState} state
 * @param {CommandWords} cw
 * @param {ScriptAt} where
 * @returns {ScriptState}
 */
function stepScript(state, cw, where) {
	const { spans } = where;
	const own = cw.words.slice(cw.wi);
	const [head = "", ...rest] = own.map((w) => literal(w, spans).text);
	const apart = runsApart(where.parsed, where.segIdx);
	const kind = exportKind(head, rest);
	if (kind !== null)
		return apart
			? state
			: exportInScript(state, { head, kind }, own.slice(1), where);
	if (movesCwd(head, rest[0]))
		return apart ? state : cdInScript(state, own, where);
	const runs = unwrap(own, spans);
	if (runs.every((run) => commandName(run.words[0] ?? "") === "git"))
		return state;
	const named = [head, ...rest].flatMap((t) => t.match(BARE_NAME_RE) ?? []);
	return markScriptUnread(
		{ ...state, lost: settleLost(state.lost, named, false) },
		cw.words,
		false,
		spans,
	);
}

/**
 * @param {ScriptState} state
 * @param {{ head: string, kind: "export" | "drop" }} command
 * @param {string[]} args
 * @param {ScriptAt} where
 * @returns {ScriptState}
 */
function exportInScript(state, command, args, where) {
	const { spans } = where;
	const texts = exportArgs(args, spans).map((a) => a.text);
	const { set, lostTo } =
		command.kind === "export"
			? assignedNames(texts, false)
			: assignedNames(texts, command.head === "unset");
	const lost = settleLost(
		settleLost(state.lost, set, isSureAssignment(where)),
		lostTo,
		false,
	);
	return { ...exportWords(state, command, args, spans), lost };
}

/**
 * @param {ScriptState} state
 * @param {{ head: string, kind: "export" | "drop" }} command
 * @param {string[]} args
 * @param {string[]} spans
 * @returns {ScriptState}
 */
function exportWords(state, { head, kind }, args, spans) {
	let { exports, unread } = state;
	const locals = new Map(state.locals);
	for (const { w, text, name } of exportArgs(args, spans)) {
		unread = unread.filter((n) => n !== name);
		if (kind === "drop") {
			exports = withoutName(exports, name, spans);
			if (head === "unset") locals.delete(name);
			continue;
		}
		if (text !== name) locals.set(name, w);
		const value = text === name ? locals.get(name) : w;
		if (value !== undefined)
			exports = [...withoutName(exports, name, spans), value];
	}
	return { ...state, exports, unread, locals };
}

/**
 * @param {ScriptState} state
 * @param {string[]} own
 * @param {ScriptAt} where
 * @returns {ScriptState}
 */
function cdInScript(state, own, where) {
	const texts = own.map((w) => literal(w, where.spans).text);
	const [head, arg] = texts;
	const known =
		head === "cd" && arg !== undefined && !arg.startsWith("-") && own[1];
	const dir = known || `$(${texts.join(" ")})`;
	const { holds, afterFailed, chained, depth, cdAt } = classifyCd(
		where.parsed,
		where.segIdx,
		own,
		state.cdAt,
	);
	/** @type {Map<string, string | null>} */
	const vars = new Map(state.locals);
	for (const name of state.lost) vars.set(name, null);
	/** @type {Chdir} */
	const cd = { dir, read: false, holds, vars, depth };
	if (afterFailed) cd.afterFailed = true;
	if (chained) cd.chained = true;
	if (state.subshellOpened) cd.opensScope = true;
	return {
		...state,
		chdirs: [...state.chdirs, cd],
		pending: chained ? [...state.pending, { depth }] : state.pending,
		subshellOpened: false,
		cdAt,
	};
}

/**
 * @param {ScriptState} state
 * @param {string[]} words
 * @param {boolean} assigning
 * @param {string[]} spans
 * @returns {ScriptState}
 */
function markScriptUnread(state, words, assigning, spans) {
	const named = repoVarsNamed(words, assigning, spans).filter(
		(n) => !state.unread.includes(n),
	);
	return named.length === 0
		? state
		: { ...state, unread: [...state.unread, ...named] };
}

/**
 * @param {string[]} args
 * @param {string[]} spans
 * @returns {{ w: string, text: string, name: string }[]}
 */
const exportArgs = (args, spans) =>
	args.flatMap((w) => {
		const text = literal(w, spans).text;
		return text.startsWith("-")
			? []
			: [{ w, text, name: assignedName(w, spans) }];
	});

/** @param {string} w @param {string[]} spans */
const assignedName = (w, spans) =>
	(literal(w, spans).text.split("=", 1)[0] ?? "").replace(/\+$/, "");

/**
 * @param {string[]} words
 * @param {string} name
 * @param {string[]} spans
 */
const withoutName = (words, name, spans) =>
	words.filter((w) => assignedName(w, spans) !== name);

/**
 * @typedef {object} GitCall
 * @property {string} segment
 * @property {string} sub
 * @property {string} tree
 * @property {string[]} args
 * @property {string[]} emptyVars
 */

/**
 * @typedef {WalkPorts & {
 *   treeClass: (dir: string) => "shared" | "linked" | "other" | "unknown",
 *   log: (what: string, detail?: string) => void,
 *   readFileAliases?: (dir: string) => import("./git-alias.js").FileAliases | null,
 * }} GitWalkPorts
 */

/**
 * @typedef {object} GitWalkOpts
 * @property {string[]} subs
 * @property {string} noun
 * @property {"shared" | "repo"} scope
 * @property {boolean} [strict]
 * @property {boolean} [emptyUnset]
 * @property {boolean} [unwrap]
 */

/**
 * @param {Parsed} parsed
 * @param {(call: GitCall) => void} fn
 * @param {GitWalkPorts} ports
 * @param {GitWalkOpts} opts
 */
function walkGit(parsed, fn, ports, opts) {
	const walk = newWalk(
		parsed,
		ports.vars,
		ports.fallbackCwd,
		opts.emptyUnset ?? false,
	);
	eachSegment(walk, (segment, cw, segIdx) => {
		const gits = readGitSegment(walk, cw, segIdx, {
			unwrapped: opts.unwrap ?? false,
			isDir: ports.isDir,
		});
		for (const git of gits) judgeGit(walk, segment, git, { fn, ports, opts });
	});
}

/**
 * @param {Walk} walk
 * @param {string} segment
 * @param {GitTarget & { sub: string, args: string[] }} git
 * @param {{ fn: (call: GitCall) => void, ports: GitWalkPorts,
 *   opts: GitWalkOpts }} with
 */
function judgeGit(walk, segment, git, { fn, ports, opts }) {
	const { subs, noun, scope, strict = false } = opts;
	const { sub, args } = expandAlias(git.sub, git.args, git.aliases, {
		subs,
		readFileAliases: () =>
			ports.readFileAliases
				? ports.readFileAliases(git.named || git.tree || ports.fallbackCwd)
				: new Map(),
	});
	if (sub === "config") markAliasWritten(walk, args);
	if (!subs.includes(sub)) return;
	const trees = [git.named, git.workTree, git.tree, ...git.doubted].filter(
		(t) => t !== null,
	);
	for (const tree of new Set(trees)) {
		/** @param {string} judged */
		const call = (judged) =>
			fn({
				segment,
				sub,
				tree: judged,
				args,
				emptyVars: [...new Set(git.names)],
			});
		judgeTree(tree, sub, call, {
			walk,
			git,
			ports,
			opts: { noun, scope, strict },
		});
	}
}

/**
 * @param {string} tree
 * @param {string} sub
 * @param {(tree: string) => void} call
 * @param {{ walk: Walk, git: GitTarget, ports: GitWalkPorts,
 *   opts: { noun: string, scope: "shared" | "repo", strict: boolean } }} from
 */
function judgeTree(tree, sub, call, { walk, git, ports, opts }) {
	if (!isResolvable(tree)) {
		if (opts.strict) call("");
		else
			ports.log(
				`could not resolve the working tree for a git ${sub} — ${opts.noun} allowed unchecked`,
				unresolvedDetail(git, walk, ports.fallbackCwd),
			);
		return;
	}
	const cls = ports.treeClass(tree);
	if (cls === "unknown")
		ports.log(
			`git could not answer for ${tree} — a git ${sub} there was allowed unchecked`,
		);
	else if (cls === "shared" || (opts.scope === "repo" && cls === "linked"))
		call(tree);
}

/**
 * @typedef {object} GitTarget
 * @property {string} tree
 * @property {string | null} named
 * @property {string | null} workTree
 * @property {string[]} doubted
 * @property {ReturnType<typeof pathArg>[]} dirMoves
 * @property {string[]} names
 * @property {string} written
 * @property {import("./git-alias.js").AliasTable} aliases
 */

/**
 * @param {Walk} walk
 * @param {CommandWords} cw
 * @param {number} segIdx
 * @param {{ unwrapped: boolean, isDir: (path: string) => boolean }} how
 * @returns {(GitTarget & { sub: string, args: string[] })[]}
 */
function readGitSegment(walk, { words, wi, assignEnd, ran }, segIdx, how) {
	settleCwdDoubt(walk, segIdx);
	if (!ran) {
		markRepoVarsUnread(walk, words, true);
		return [];
	}
	const own = words.slice(wi);
	if (stepCwd(walk, own, segIdx, how.isDir)) return [];
	if (trackExport(walk, own)) return [];
	const leading = words.slice(0, assignEnd);
	const scopes = leadingScopes(walk, leading, segIdx);
	const unwrapped = unwrap(own, walk.scope.spans);
	const runs = how.unwrapped
		? unwrapped
		: [
				{ words: own, wrapperWords: [], chdirs: [], unread: [] },
				...unwrapped.filter((run) => run.scripted),
			];
	const gitRuns = runs.filter(
		(run) => commandName(run.words[0] ?? "") === "git",
	);
	const gits = gitRuns.flatMap((run) => {
		const git = readGitRun(walk, run, { leading, scopes }, how.isDir);
		return git ? [git] : [];
	});
	if (gitRuns.length < runs.length) markRepoVarsUnread(walk, words, false);
	return gits;
}

/**
 * @param {Walk} walk
 * @param {Pick<Unwrapped, "words" | "wrapperWords" | "chdirs" | "unread">} run
 * @param {{ leading: string[], scopes: Map<string, Scope> }} prefix
 * @param {(path: string) => boolean} isDir
 * @returns {(GitTarget & { sub: string, args: string[] }) | null}
 */
function readGitRun(walk, run, { leading, scopes }, isDir) {
	const { words: own, chdirs } = run;
	/** @type {Map<string, GitDirWord>} */
	const dirEnv = new Map();
	for (const [name, word] of walk.gitEnv)
		dirEnv.set(name, { word, scope: walk.scope });
	for (const [name, word] of leading.flatMap(parseGitEnvWord))
		dirEnv.set(name, { word, scope: scopes.get(name) ?? walk.scope });
	for (const [name, word] of run.wrapperWords.flatMap(parseGitEnvWord))
		dirEnv.set(name, { word, scope: walk.scope });
	for (const name of run.unread)
		dirEnv.set(name, { word: null, scope: walk.scope });
	/** @type {GitEnv} */
	const env = new Map([...dirEnv].map(([name, dir]) => [name, dir.word]));
	const { spans } = walk.scope;
	/** @type {GitTarget} */
	const target = {
		tree: cwdOf(walk),
		named: null,
		workTree: null,
		doubted: [],
		dirMoves: [],
		names: walk.cwdNames,
		written: "",
		aliases: emptyAliasTable(),
	};
	target.aliases.anyUnread = walk.aliasWritten;
	defineFromEnv(target.aliases, env, spans);
	const moves = chdirs.map((cd) => {
		const { resolved, emptyNames } = chdirArg(cd, walk.scope);
		moveGitTarget(target, resolved, cd.dir, emptyNames);
		return chdirMove(cd, resolved);
	});
	const i = readGitOptions(own, target, {
		scope: walk.scope,
		dirEnv,
		isDir,
	});
	const word = own[i];
	if (word === undefined) return null;
	/** @type {import("./shell-dirs.js").Move[]} */
	const dashC = target.dirMoves.map((resolved) => ({
		resolved,
		holds: "always",
	}));
	[, ...target.doubted] = dirsAfter(
		walk.dirs.dirs,
		[...moves, ...dashC],
		isDir,
	);
	target.aliases.anyUnread ||= target.doubted.length > 0;
	const args = own.slice(i + 1);
	const spelt = literal(word, spans);
	if (!spelt.known)
		return {
			...target,
			named: target.named ?? "",
			sub: UNREAD_ALIAS,
			args: [],
		};
	return { ...target, sub: spelt.text, args };
}

const COMPOUND_START =
	/^\s*(?:if|while|until|for|select|case|function)(?:\s|$)/;

/** @param {Parsed} parsed @param {number} segIdx */
function nextInList({ lifted }, segIdx) {
	let i = segIdx + 1;
	if (lifted[segIdx]) return i;
	while (lifted[i]) i++;
	return i;
}

/** @param {Parsed} parsed @param {number} segIdx */
function prevInList({ lifted }, segIdx) {
	let i = segIdx - 1;
	if (lifted[segIdx]) return i;
	while (lifted[i]) i--;
	return i;
}

/** @param {Parsed} parsed @param {number} segIdx */
const joinAfter = (parsed, segIdx) => parsed.joins[nextInList(parsed, segIdx)];

/** @param {Parsed} parsed @param {number} segIdx */
function runsApart(parsed, segIdx) {
	const after = joinAfter(parsed, segIdx);
	return (
		parsed.joins[segIdx] === JOIN.PIPE ||
		after === JOIN.PIPE ||
		after === JOIN.BACKGROUND
	);
}

/** @param {Join[]} joins @param {number} segIdx */
const opensList = (joins, segIdx) =>
	joins[segIdx] !== JOIN.AND && joins[segIdx] !== JOIN.OR;

/** @param {Parsed} parsed @param {number} segIdx @param {number} cdAt */
const isAfterCd = (parsed, segIdx, cdAt) =>
	parsed.joins[segIdx] === JOIN.OR && cdAt === prevInList(parsed, segIdx);

/** @param {string[]} segments @param {number} segIdx */
function isNegated(segments, segIdx) {
	const segment = segments[segIdx];
	if (segment === undefined) return false;
	return (
		segment
			.trim()
			.split(/\s+/)
			.find((w) => w !== "{") === "!"
	);
}

/** @param {Parsed} parsed @param {number} segIdx */
const isChainedOff = (parsed, segIdx) =>
	joinAfter(parsed, segIdx) === JOIN.AND &&
	parsed.joins[segIdx] !== JOIN.OR &&
	!isNegated(parsed.segments, segIdx);

/** @type {readonly Join[]} */
const IN_LIST = [JOIN.AND, JOIN.OR, JOIN.PIPE];

/** @param {Join | undefined} join */
const isInList = (join) => join !== undefined && IN_LIST.includes(join);

/** @param {Parsed} parsed @param {number} segIdx */
function isListBackgrounded(parsed, segIdx) {
	const { joins } = parsed;
	let end = nextInList(parsed, segIdx);
	while (isInList(joins[end]))
		end = nextInList(parsed, commandEnd(parsed, end));
	return joins[end] === JOIN.BACKGROUND;
}

/** @type {WeakMap<Parsed, Compound[] | null>} */
const compoundMemo = new WeakMap();

/** @typedef {[from: number, to: number, opener: string]} Compound */

const CLOSERS = new Map([
	["}", ["{"]],
	["fi", ["if"]],
	["done", ["while", "until", "for", "select"]],
	["esac", ["case"]],
]);

const OPENERS = new Set([...CLOSERS.values()].flat());

/** @param {string} word */
function closerOf(word) {
	if (/^\}(?=$|[<>])/.test(word)) return "}";
	return CLOSERS.has(word) ? word : undefined;
}

/** @param {string} segment */
function compoundWords(segment) {
	const words = segment.trim().split(/\s+/);
	/** @type {string[]} */
	const closes = [];
	let wi = 0;
	for (let c = closerOf(words[wi] ?? ""); c; c = closerOf(words[wi] ?? "")) {
		closes.push(c);
		wi++;
	}
	const end = skipReserved(words, wi);
	const opens = words.slice(wi, end).filter((w) => OPENERS.has(w));
	const next = words[end];
	if (next !== undefined && OPENERS.has(next) && !RESERVED_WORDS.includes(next))
		opens.push(next);
	return { closes, opens };
}

/** @param {string[]} segments @param {number} at */
function holdsCommands(segments, at) {
	const before = segments[at - 1] ?? "";
	if (/[=]\s*$/.test(before)) return false;
	return !(before.trim() === "" && segments[at - 2] === SCOPE_OPEN);
}

/** @param {string[]} segments @param {number} from @param {number} to */
const isFunctionParens = (segments, from, to) =>
	to === from + 2 &&
	segments[from + 1]?.trim() === "" &&
	/^\s*(?:function\s+)?[^\s$=<>|&;`'"]+\s*$/.test(segments[from - 1] ?? "");

/** @param {Parsed} parsed @returns {boolean[]} */
function commandStarts({ segments, joins }) {
	/** @type {{ from: number, holds: boolean }[]} */
	const brackets = [];
	let afterBracket = false;
	return segments.map((segment, i) => {
		if (segment === SCOPE_OPEN) {
			brackets.push({ from: i, holds: holdsCommands(segments, i) });
			return false;
		}
		if (segment === SCOPE_CLOSE) {
			const closed = brackets.pop();
			afterBracket =
				closed !== undefined && !isFunctionParens(segments, closed.from, i);
			return false;
		}
		const rest = joins[i] === JOIN.AFTER_CLOSE && afterBracket;
		return !rest && brackets.every((b) => b.holds);
	});
}

/** @param {Parsed} parsed @returns {Compound[] | null} */
function compoundSpans(parsed) {
	const known = compoundMemo.get(parsed);
	if (known !== undefined) return known;
	const starts = commandStarts(parsed);
	/** @type {[number, string][]} */
	const open = [];
	/** @type {Compound[] | null} */
	let groups = [];
	scan: for (const [i, segment] of parsed.segments.entries()) {
		if (!starts[i]) continue;
		const { closes, opens } = compoundWords(segment);
		for (const closer of closes) {
			const top = open.pop();
			if (!top || !CLOSERS.get(closer)?.includes(top[1])) {
				groups = null;
				break scan;
			}
			groups.push([top[0], i, top[1]]);
		}
		for (const opener of opens) open.push([i, opener]);
	}
	if (open.length > 0) groups = null;
	compoundMemo.set(parsed, groups);
	return groups;
}

/** @param {Parsed} parsed @param {number} segIdx */
const runDepth = (parsed, segIdx) =>
	(compoundSpans(parsed) ?? []).filter(
		([from, to]) => from <= segIdx && segIdx < to,
	).length;

/** @param {Parsed} parsed @param {number} segIdx */
function chainEndDepth(parsed, segIdx) {
	if (!isChainEnd(parsed.joins, segIdx)) return;
	return (compoundSpans(parsed) ?? []).filter(
		([from, to]) => from < segIdx && segIdx <= to,
	).length;
}

/** @param {Parsed} parsed @param {number} segIdx */
function commandEnd(parsed, segIdx) {
	let end = groupEnd(parsed, segIdx);
	for (
		let next = stepPast(parsed, end);
		next !== end;
		next = stepPast(parsed, end)
	)
		end = next;
	return end;
}

/** @param {Parsed} parsed @param {number} segIdx */
const groupEnd = (parsed, segIdx) =>
	parsed.segments[segIdx] === SCOPE_OPEN
		? closingBracket(parsed.segments, segIdx)
		: closingCompound(parsed, segIdx);

/** @param {Parsed} parsed @param {number} end */
function stepPast(parsed, end) {
	const { segments, joins } = parsed;
	const next = end + 1;
	if (joins[next] === JOIN.AFTER_CLOSE) return closingCompound(parsed, next);
	if (segments[next] !== SCOPE_OPEN || joins[next] !== JOIN.NONE) return end;
	const close = closingBracket(segments, next);
	if (!isFunctionParens(segments, next, close))
		return segments[end]?.trim() ? close : end;
	let body = close + 1;
	while (body < segments.length - 1 && !segments[body]?.trim()) body++;
	return groupEnd(parsed, body);
}

/** @param {string[]} segments @param {number} openIdx */
function closingBracket(segments, openIdx) {
	let depth = 0;
	for (let i = openIdx; i < segments.length; i++) {
		if (segments[i] === SCOPE_OPEN) depth++;
		else if (segments[i] === SCOPE_CLOSE && --depth === 0) return i;
	}
	return segments.length - 1;
}

/** @param {Parsed} parsed @param {number} segIdx */
function closingCompound(parsed, segIdx) {
	let end = segIdx;
	for (const [from, to] of compoundSpans(parsed) ?? [])
		if (from === segIdx && to > end) end = to;
	return end;
}

/** @param {Parsed} parsed @param {number} segIdx */
function isBraceGroupSure(parsed, segIdx) {
	const { joins, segments } = parsed;
	const groups = compoundSpans(parsed);
	if (!groups) return false;
	return groups.every(([from, to, opener]) => {
		if (opener !== "{" || segIdx < from || segIdx > to) return true;
		const before = joins[from];
		let prev = prevInList(parsed, from);
		while (prev >= 0 && segments[prev]?.trim() === "")
			prev = prevInList(parsed, prev);
		const defined =
			(before === JOIN.NONE || before === JOIN.AFTER_CLOSE) &&
			segments[prev] === SCOPE_CLOSE;
		return (
			!defined &&
			!isInList(before) &&
			joinAfter(parsed, to) !== JOIN.PIPE &&
			!isListBackgrounded(parsed, to)
		);
	});
}

/** @param {Parsed} parsed @param {number} segIdx @param {string[]} own */
const isSureOnceReached = (parsed, segIdx, own) =>
	!isListBackgrounded(parsed, segIdx) &&
	own.length <= 2 &&
	!parsed.segments.some((s) => COMPOUND_START.test(s)) &&
	isBraceGroupSure(parsed, segIdx);

/** @param {Parsed} parsed @param {number} segIdx @param {string[]} own */
function isSureMove(parsed, segIdx, own) {
	return (
		opensList(parsed.joins, segIdx) && isSureOnceReached(parsed, segIdx, own)
	);
}

/**
 * @param {Parsed} parsed
 * @param {number} segIdx
 * @param {string[]} own
 * @param {number} cdAt
 * @returns {{ holds: "if-dir" | "maybe", afterFailed: boolean,
 *   chained: boolean, depth: number, cdAt: number }}
 */
function classifyCd(parsed, segIdx, own, cdAt) {
	const opens = opensList(parsed.joins, segIdx);
	const afterFailed = isAfterCd(parsed, segIdx, cdAt);
	return {
		holds:
			(opens || afterFailed) && isSureOnceReached(parsed, segIdx, own)
				? "if-dir"
				: "maybe",
		afterFailed,
		chained: isChainedOff(parsed, segIdx),
		depth: runDepth(parsed, segIdx),
		cdAt: opens && !isNegated(parsed.segments, segIdx) ? segIdx : -1,
	};
}

/** @param {Walk} walk @param {number} segIdx */
function settleCwdDoubt(walk, segIdx) {
	const { parsed } = walk;
	const ends = chainEndDepth(parsed, segIdx);
	if (ends !== undefined) walk.dirs = settleDirs(walk.dirs, ends);
}

/**
 * @param {Walk} walk
 * @param {string[]} own
 * @param {number} segIdx
 * @param {(path: string) => boolean} isDir
 */
function stepCwd(walk, own, segIdx, isDir) {
	const [head = "", arg] = own;
	if (!movesCwd(head, arg)) return false;
	const { cwdNames, cwdLost } = walk;
	const resolved = moveCwd(walk, own);
	if (runsApart(walk.parsed, segIdx)) {
		Object.assign(walk, { cwdNames, cwdLost });
		return true;
	}
	const { cdAt, ...move } = classifyCd(walk.parsed, segIdx, own, walk.cdAt);
	walk.dirs = stepDirs(walk.dirs, { resolved, ...move }, isDir);
	walk.cdAt = cdAt;
	return true;
}

/** @param {Walk} walk */
const cwdOf = (walk) => walk.dirs.dirs[0];

/**
 * @param {import("./shell-dirs.js").Dirs} cwds
 * @param {Chdir[]} chdirs
 * @param {Scope} scope
 * @param {(path: string) => boolean} isDir
 * @returns {import("./shell-dirs.js").Dirs}
 */
function runCwd(cwds, chdirs, scope, isDir) {
	const moves = chdirs.map((cd) => chdirMove(cd, chdirArg(cd, scope).resolved));
	return dirsAfter(cwds, moves, isDir);
}

/**
 * @param {Chdir} cd
 * @param {import("./shell-dirs.js").Resolved} resolved
 * @returns {import("./shell-dirs.js").Move}
 */
const chdirMove = ({ dir, read, vars, envReset, ...move }, resolved) => ({
	resolved,
	...move,
});

const CONFIG_READ = /^(?:--get|--list$|-l$)/;

/** @param {Walk} walk @param {string[]} args */
function markAliasWritten(walk, args) {
	const read = args.map((w) => literal(w, walk.scope.spans));
	if (read.some((l) => CONFIG_READ.test(l.text))) return;
	walk.aliasWritten ||= read.some((l, i) =>
		l.known ? isAliasKey(l.text) : i === 0 || i < read.length - 1,
	);
}

const REPO_VARS = ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE"];

const GIT_ENV_NAME = new RegExp(
	`^(?:${[...REPO_VARS, ...CONFIG_FILE_VARS].join("|")}|GIT_CONFIG_COUNT|GIT_CONFIG_PARAMETERS|GIT_CONFIG_(?:KEY|VALUE)_\\d+)$`,
);

/**
 * @param {string} word
 * @returns {[string, string][]}
 */
function parseGitEnvWord(word) {
	const eq = word.indexOf("=");
	const name = word.slice(0, eq);
	return eq > 0 && GIT_ENV_NAME.test(name) ? [[name, word.slice(eq + 1)]] : [];
}

/** @param {Walk} walk @param {string[]} words @param {boolean} assigning */
function markRepoVarsUnread(walk, words, assigning) {
	const named = repoVarsNamed(words, assigning, walk.scope.spans);
	if (named.length === 0) return;
	walk.gitEnv = new Map(walk.gitEnv);
	for (const name of named) walk.gitEnv.set(name, null);
}

/**
 * @param {string[]} words
 * @param {boolean} assigning
 * @param {string[]} spans
 */
function repoVarsNamed(words, assigning, spans) {
	const text = words.map((w) => literal(w, spans).text).join(" ");
	const candidates = [
		...REPO_VARS,
		...CONFIG_FILE_VARS.filter((name) => assigning || name.startsWith("GIT_")),
	];
	return candidates.filter((name) => new RegExp(`\\b${name}\\b`).test(text));
}

/**
 * @param {string} head
 * @param {string[]} rest
 * @returns {"export" | "drop" | null}
 */
function exportKind(head, rest) {
	if (head === "unset") return "drop";
	const declares =
		(head === "declare" || head === "typeset") &&
		rest.some((w) => /^-\w*x/.test(w));
	if (head !== "export" && !declares) return null;
	return rest.includes("-n") ? "drop" : "export";
}

/** @param {Walk} walk @param {string[]} words */
function trackExport(walk, [head = "", ...rest]) {
	const kind = exportKind(head, rest);
	if (kind === null) return false;
	const env = new Map(walk.gitEnv);
	for (const { text } of exportArgs(rest, walk.scope.spans)) {
		const [name = ""] = text.split("=", 1);
		if (!GIT_ENV_NAME.test(name)) continue;
		if (kind === "drop") env.delete(name);
		else
			env.set(name, text === name ? `$${name}` : text.slice(name.length + 1));
	}
	walk.gitEnv = env;
	return true;
}

/**
 * What one of git's own options says, its value `next` where it takes the next
 * word and spelt on where it is stuck.
 * @param {string} w
 * @param {string} next
 * @param {GitTarget} target accumulator: its tree and aliases are moved
 * @param {{ scope: Scope, dirs: GitDirs }} from `dirs`, an accumulator,
 *   holds the directories read after the `-C`s end
 */
function stepGitOption(w, next, target, { scope, dirs }) {
	const { spans } = scope;
	if (w === "--git-dir") dirs.gitDir = { word: next, scope };
	else if (w.startsWith("--git-dir="))
		dirs.gitDir = { word: w.slice("--git-dir=".length), scope };
	else if (w === "--work-tree") dirs.workTree = { word: next, scope };
	else if (w.startsWith("--work-tree="))
		dirs.workTree = { word: w.slice("--work-tree=".length), scope };
	else if (w === "-C") readGitDir(next, target, scope);
	else if (w === "-c") defineFromConfigWord(target.aliases, next, spans);
	else if (w === "--config-env")
		defineFromConfigEnvWord(target.aliases, next, spans);
	else if (w.startsWith("--config-env="))
		defineFromConfigEnvWord(
			target.aliases,
			w.slice("--config-env=".length),
			spans,
		);
}

/**
 * @param {string[]} own
 * @param {GitTarget} target
 * @param {{ scope: Scope, dirEnv: Map<string, GitDirWord>,
 *   isDir: (path: string) => boolean }} from
 */
function readGitOptions(own, target, { scope, dirEnv, isDir }) {
	/** @type {GitDirs} */
	const dirs = {
		gitDir: dirEnv.get("GIT_DIR"),
		workTree: dirEnv.get("GIT_WORK_TREE"),
	};
	const i = stepGitOptions(own, scope.spans, (w, next) =>
		stepGitOption(w, next ?? "", target, { scope, dirs }),
	);
	nameRepoTree(dirs.gitDir, dirEnv.get("GIT_COMMON_DIR"), target, isDir);
	nameWorkTree(dirs.workTree, target);
	return i;
}

/**
 * @typedef {{ word: string | null, scope: Scope }} GitDirWord
 * @typedef {{ gitDir?: GitDirWord, workTree?: GitDirWord }} GitDirs
 */

/** @param {string} word @param {GitTarget} target @param {Scope} scope */
function absFromTree(word, target, scope) {
	const r = pathArg(word, scope);
	const path = r && "path" in r ? r.path : "";
	const abs =
		path.startsWith("/") || !path || !target.tree
			? path
			: `${target.tree}/${path}`;
	return abs.startsWith("/") ? abs : "";
}

/** @param {GitDirWord | undefined} named @param {GitTarget} target */
function nameWorkTree(named, target) {
	if (named === undefined) return;
	const { word, scope } = named;
	const abs = word === null ? "" : absFromTree(word, target, scope);
	target.workTree = abs && normAbs(abs);
	if (!abs) target.written = `--work-tree ${word}`;
}

/**
 * @param {GitDirWord | undefined} gitDir
 * @param {GitDirWord | undefined} commonDir
 * @param {GitTarget} target
 * @param {(path: string) => boolean} isDir
 */
function nameRepoTree(gitDir, commonDir, target, isDir) {
	const named = gitDir === undefined ? commonDir : gitDir;
	if (named === undefined) return;
	const { word, scope } = named;
	const both = gitDir !== undefined && commonDir !== undefined;
	const abs = both || word === null ? "" : absFromTree(word, target, scope);
	const tree = abs ? treeOfGitDir(abs) : "";
	const readable = tree !== "" && (tree !== normAbs(abs) || isDir(abs));
	target.named = readable ? tree : "";
	if (!readable) target.written = `--git-dir ${word}`;
}

/** @param {string} dir */
const treeOfGitDir = (dir) => normAbs(dir).replace(/\/\.git$/, "") || "/";

/** @param {string} word @param {GitTarget} target @param {Scope} scope */
function readGitDir(word, target, scope) {
	const r = pathArg(word, scope);
	target.dirMoves.push(r);
	moveGitTarget(target, r, word, scope.emptyNames);
}

/**
 * @param {GitTarget} target
 * @param {ReturnType<typeof pathArg>} r
 * @param {string} word
 * @param {string[]} emptyNames
 */
function moveGitTarget(target, r, word, emptyNames) {
	const from = target.tree;
	target.tree = moveDir(from, r);
	if (!r) target.written = `-C ${word}`;
	else if ("path" in r && r.path.startsWith("/")) {
		target.names = [...emptyNames];
		target.written = "";
	} else if ("empty" in r || from)
		target.names = [...target.names, ...emptyNames];
}

/**
 * @param {Chdir} cd
 * @param {Scope} scope
 * @returns {{ resolved: ReturnType<typeof pathArg>, emptyNames: string[] }}
 */
function chdirArg(cd, scope) {
	const none = { resolved: null, emptyNames: [] };
	if (cd.read && cd.dir.startsWith("-")) return none;
	if (cd.read)
		return {
			resolved: cd.dir ? { path: cd.dir } : { empty: true },
			emptyNames: [],
		};
	if (isGlobPattern(cd.dir)) return none;
	const inner = cd.vars ? buildScriptScope(cd, scope) : scope;
	const r = pathArg(cd.dir, inner);
	if (r && "path" in r && r.path.startsWith("-")) return none;
	return { resolved: r, emptyNames: inner.emptyNames };
}

/**
 * @param {string[]} spans
 * @returns {Scope}
 */
const buildBareScope = (spans) => ({
	spans,
	locals: new Map(),
	dead: new Set(),
	exported: new Set(),
	harvested: new Map(),
	vars: {},
	subject: "",
	conditional: -1,
	emptyUnset: false,
	emptyNames: [],
});

const SHELL_SET = ["PWD", "OLDPWD", "_"];

/** @param {Chdir} cd @param {Scope} outer @returns {Scope} */
function buildScriptScope({ vars = new Map(), envReset }, outer) {
	const inherits = !envReset && !SOURCING_RE.test(outer.subject);
	/** @type {Scope} */
	const scope = {
		...buildBareScope(outer.spans),
		dead: new Set([...SHELL_SET, ...vars.keys()]),
		vars: inherits ? buildInheritedEnv(outer) : {},
	};
	/** @type {Map<string, string>} */
	const locals = new Map();
	const dead = new Set(SHELL_SET);
	for (const [name, word] of vars) {
		const raw = word?.slice(word.indexOf("=") + 1);
		const val = raw === undefined ? null : assignedValue(raw, scope);
		if (val) locals.set(name, val);
		else dead.add(name);
	}
	return { ...scope, locals, dead, emptyNames: [] };
}

/** @param {Scope} outer @returns {Record<string, string | undefined>} */
function buildInheritedEnv(outer) {
	/** @type {Record<string, string | undefined>} */
	const env = {};
	for (const [name, value] of Object.entries(outer.vars))
		if (bareMentions(name, outer.subject) === 0) env[name] = value;
	for (const name of outer.exported) {
		const seen = outer.harvested.get(name) ?? 0;
		const value =
			bareMentions(name, outer.subject) === seen
				? lookupVar(name, outer)
				: null;
		if (value === null) delete env[name];
		else env[name] = value;
	}
	return env;
}

/** @param {GitTarget} git @param {Walk} walk @param {string} pwd */
function unresolvedDetail(git, walk, pwd) {
	const t = git.written || git.tree || walk.cwdLost;
	const typed = asWritten(t || "<unknown>", walk.scope.spans);
	return `target=${typed} pwd=${pwd} cwd=${cwdOf(walk) || "<unknown>"}`;
}

/** @param {string[]} emptyVars */
function unsetText(emptyVars) {
	const names = [...new Set(emptyVars)];
	if (names.length === 0) return "";
	const list = names.map((n) => `\`$${n}\``).join(", ");
	const verb = names.length === 1 ? "is" : "are";
	return `${list} ${verb} unset in this call; shell variables do not carry over between Bash calls.\n\n`;
}

/**
 * @param {RedirectEntry[]} redirs
 * @param {Scope} scope
 * @param {(word: string) => string} resolveAbs
 * @returns {Redirect[]}
 */
function readRedirects(redirs, scope, resolveAbs) {
	return redirs.map((entry) => readRedirect(entry, scope, resolveAbs));
}

/**
 * @param {RedirectEntry} entry
 * @param {Scope} scope
 * @param {(word: string) => string} resolveAbs
 * @returns {Redirect}
 */
function readRedirect({ fd: written, op, target }, scope, resolveAbs) {
	const copy =
		op === ">&" || op === "<&"
			? readDescriptorCopy(op, written, target, scope)
			: null;
	const kind = copy ? copy.kind : (REDIRECT_KINDS.get(op) ?? "");
	let fd = copy ? copy.fd : written;
	if (!fd) fd = op.startsWith("<") ? "0" : "1";
	const path =
		kind === "read" || isWriteRedirect(kind) ? resolveAbs(target) : "";
	return { fd, kind, target, path };
}

const REDIRECT_KINDS = new Map([
	[">", "truncate"],
	["&>", "truncate"],
	[">|", "clobber"],
	[">>", "append"],
	["&>>", "append"],
	["<", "read"],
	["<>", "read-write"],
	["<<<", "here-string"],
	["<<", "heredoc"],
	["<<-", "heredoc"],
]);

/**
 * @param {string} op
 * @param {string} fd
 * @param {string} target
 * @param {Scope} scope
 */
function readDescriptorCopy(op, fd, target, scope) {
	const word = resolveWord(target, scope) ?? "1";
	if (word === "-") return { kind: "close", fd };
	if (/^[0-9]+-?$/.test(word)) return { kind: "copy", fd };
	if (op === ">&" && !fd) return { kind: "truncate", fd: "&" };
	return { kind: "read", fd };
}

/** @param {string} raw @param {Scope} scope */
function assignedValue(raw, scope) {
	if (!raw) return "";
	const r = pathArg(raw, scope);
	if (!r) return null;
	return "path" in r ? r.path : "";
}

/** @param {Scope} scope @param {string} name @param {string | null} val */
function recordAssignment(scope, name, val) {
	const prior = scope.locals.get(name);
	if (val === null || (prior !== undefined && prior !== val)) {
		scope.locals.delete(name);
		scope.dead.add(name);
		return;
	}
	scope.locals.set(name, val);
}

/**
 * @param {string[]} words
 * @param {Redirect[]} redirects
 * @param {{ spans: string[], resolveAbs: (w: string) => string, resolve: (w: string) => string | null, isDir: (p: string) => boolean }} ctx
 * @returns {WriteTarget[]}
 */
function writeTargets(words, redirects, ctx) {
	/** @type {WriteTarget[]} */
	const rows = [];
	let route = "redirect";
	/** @type {AddTarget} */
	const add = (mode, target, path = ctx.resolveAbs(target)) => {
		rows.push({ mode, route, target, path });
	};
	for (const r of redirects)
		if (isWriteRedirect(r.kind)) add("write", r.target, r.path);
	const [command = "", ...args] = words;
	const head = literal(command, ctx.spans);
	if (!head.known) return rows;
	const base = basename(head.text);
	route = base === "git" ? `git ${args[0] ?? ""}` : base;
	COMMAND_TARGETS.get(base)?.(args, add, ctx);
	return rows;
}

/**
 * @typedef {{ spans: string[], resolveAbs: (w: string) => string, resolve: (w: string) => string | null, isDir: (p: string) => boolean }} TargetCtx
 */

/**
 * @typedef {(mode: WriteTarget["mode"], target: string, path?: string) => void} AddTarget
 */

/**
 * @type {Map<string, (args: string[], add: AddTarget, ctx: TargetCtx) => void>}
 */
const COMMAND_TARGETS = new Map([
	["cp", (args, add, ctx) => copyTargets("cp", args, add, ctx)],
	["mv", (args, add, ctx) => copyTargets("mv", args, add, ctx)],
	[
		"sed",
		(args, add) => {
			if (isInPlace("efl", args))
				bareTargets(["-e", "-f", "--expression", "--file"], args, add);
		},
	],
	[
		"perl",
		(args, add) => {
			if (isInPlace("0CDeEFIlmMx", args))
				bareTargets(["-e", "-E", "-I", "-m", "-M", "-F"], args, add);
		},
	],
	[
		"truncate",
		(args, add) =>
			bareTargets(["-s", "--size", "-r", "--reference"], args, add),
	],
	["tee", (args, add) => bareTargets([], args, add)],
	["rm", (args, add) => deleteTargets(args, add)],
	["git", (args, add) => gitTargets(args, add)],
]);

/** @param {string[]} args @param {AddTarget} add */
function gitTargets(args, add) {
	const [sub, ...rest] = args;
	if (sub === "restore") {
		const staged = rest.includes("--staged") || rest.includes("-S");
		const worktree = rest.includes("--worktree") || rest.includes("-W");
		if (!staged || worktree)
			bareTargets(["-s", "--source", "--pathspec-from-file"], rest, add);
	} else if (sub === "checkout") {
		const sep = rest.indexOf("--");
		if (sep >= 0) for (const w of rest.slice(sep + 1)) add("write", w);
	} else if (sub === "mv" || sub === "rm") deleteTargets(rest, add);
}

/** @param {string[]} skip @param {string[]} ws @param {AddTarget} add */
function bareTargets(skip, ws, add) {
	let value = false;
	for (const w of ws) {
		if (value) {
			value = false;
			continue;
		}
		if (w === "--") continue;
		if (w.startsWith("-")) {
			value = skip.includes(w);
			continue;
		}
		add("write", w);
	}
}

/** @param {string[]} ws @param {AddTarget} add */
function deleteTargets(ws, add) {
	let sep = false;
	for (const w of ws) {
		if (!sep && w === "--") {
			sep = true;
			continue;
		}
		if (!sep && w.startsWith("-")) continue;
		add("delete", w);
	}
}

/** @param {string} takesArg @param {string[]} words */
function isInPlace(takesArg, words) {
	for (const w of words) {
		if (w === "--in-place" || w.startsWith("--in-place=")) return true;
		if (w === "--") return false;
		if (isShortFlags(w) && hasInPlaceLetter(w, takesArg)) return true;
	}
	return false;
}

/** @param {string} w */
const isShortFlags = (w) => w.startsWith("-") && !w.startsWith("--");

/** @param {string} w @param {string} takesArg */
function hasInPlaceLetter(w, takesArg) {
	for (const ch of w.slice(1)) {
		if (ch === "i") return true;
		if (takesArg.includes(ch)) return false;
	}
	return false;
}

/**
 * @param {string} prog
 * @param {string[]} args
 * @param {AddTarget} add
 * @param {TargetCtx} ctx
 */
function copyTargets(prog, args, add, ctx) {
	const picked = pickDestination(parseCopyArgs(args));
	if (!picked) return;
	const { srcs, dest } = picked;
	const dpath = ctx.resolveAbs(dest.text);
	const lit = literal(dest.text, ctx.spans).text;
	if (!lit && !dpath) return;
	const into = isDirectoryDest(dpath, lit, ctx) || dest.into;
	const dir = { base: dest.text.replace(/\/$/, ""), dpath };
	for (const src of srcs) {
		if (into) addIntoTarget(src, dir, add, ctx);
		if (prog === "mv") add("move-source", src);
	}
	if (!into) add("write", dest.text, dpath);
}

const COPY_VALUE_FLAGS = new Map([
	["-t", 1],
	["--target-directory", 1],
	["-S", 2],
	["--suffix", 2],
]);

/** @param {string[]} args */
function parseCopyArgs(args) {
	let dest = "";
	/** @type {string[]} */
	const srcs = [];
	let value = 0;
	for (const w of args) {
		if (value) {
			if (value === 1) dest = w;
			value = 0;
			continue;
		}
		const takes = COPY_VALUE_FLAGS.get(w);
		if (takes) value = takes;
		else if (w.startsWith("--target-directory="))
			dest = w.slice(w.indexOf("=") + 1);
		else if (!w.startsWith("-")) srcs.push(w);
	}
	return { dest, srcs };
}

/** @param {{ dest: string, srcs: string[] }} parsed */
function pickDestination({ dest, srcs }) {
	if (dest) return { srcs, dest: { text: dest, into: true } };
	if (srcs.length < 2) return null;
	const last = srcs.pop();
	if (last === undefined) return null;
	return { srcs, dest: { text: last, into: srcs.length >= 2 } };
}

/** @param {string} dpath @param {string} lit @param {TargetCtx} ctx */
const isDirectoryDest = (dpath, lit, ctx) =>
	Boolean(dpath && ctx.isDir(dpath)) || lit.endsWith("/");

/**
 * @param {string} src
 * @param {{ base: string, dpath: string }} dir
 * @param {AddTarget} add
 * @param {TargetCtx} ctx
 */
function addIntoTarget(src, { base, dpath }, add, ctx) {
	const name = literal(src, ctx.spans);
	const tgt = `${base}/${basename(name.known ? name.text : src)}`;
	const rsrc = ctx.resolve(src) ?? name.text;
	add("write", tgt, dpath && rsrc ? normAbs(`${dpath}/${basename(rsrc)}`) : "");
}

/**
 * @typedef {import("./shell-words.js").Unwrapped} Unwrapped
 * @typedef {import("./shell-words.js").WrapperGrammar} WrapperGrammar
 * @typedef {import("./shell-words.js").WrapperOption} WrapperOption
 */

/**
 * @param {string[]} words
 * @param {string[]} spans
 * @param {string[]} [judged]
 * @returns {[Unwrapped, ...Unwrapped[]]}
 */
function unwrap(words, spans, judged = []) {
	/** @type {Unwrapped[]} */
	const pending = [];
	const first = stripRun(buildBareRun(words), { spans, judged, pending });
	/** @type {Unwrapped[]} */
	const later = [];
	for (let run = pending.shift(); run !== undefined; run = pending.shift())
		later.push(stripRun(run, { spans, judged, pending }));
	return [first, ...later];
}

/** @param {string[]} argv @returns {Unwrapped[]} */
function unwrapArgv(argv) {
	/** @type {string[]} */
	const spans = [];
	return unwrap(argv, spans).map((run) => ({
		...run,
		words: run.words.map((w) => literal(w, spans).text),
	}));
}

/**
 * @param {Unwrapped} run
 * @param {{ spans: string[], judged: string[], pending: Unwrapped[] }} with
 * @returns {Unwrapped}
 */
function stripRun(run, { spans, judged, pending }) {
	const st = buildStrip(run, judged, pending);
	stripWrappers(st, spans);
	return {
		words: st.ws,
		wrapperWords: st.wrapperWords,
		chdirs: st.chdirs,
		unread: st.unread,
		watched: st.watched,
		scripted: st.scripted,
	};
}

/** @param {Strip} st @param {string[]} spans */
function stripWrappers(st, spans) {
	for (let first = st.ws[0]; first !== undefined; first = st.ws[0]) {
		const step = stripOne(st, first, spans);
		if (step === "cut") st.ws = [];
		if (step !== "next") break;
	}
}

/** @param {string[]} words @param {string[]} spans */
function isScriptNext(words, spans) {
	const st = buildStrip(buildBareRun(words), [], []);
	stripWrappers(st, [...spans]);
	return st.awaitsScript;
}

/**
 * @param {string[]} words
 * @param {string[]} spans
 * @returns {string | null}
 */
function wrapperScript(words, spans) {
	const [first] = words;
	if (first === undefined) return null;
	const st = buildStrip(buildBareRun(words), [], []);
	stripOne(st, first, [...spans]);
	return st.script;
}

/**
 * @param {string[]} words
 * @returns {Unwrapped}
 */
const buildBareRun = (words) => ({
	words,
	wrapperWords: [],
	chdirs: [],
	unread: [],
	watched: false,
	scripted: false,
});

/**
 * @param {Unwrapped} run
 * @param {string[]} judged
 * @param {Unwrapped[]} pending
 * @returns {Strip}
 */
const buildStrip = (run, judged, pending) => ({
	ws: [...run.words],
	judged,
	inEnv: false,
	envReset: run.envReset ?? false,
	execs: false,
	awaitsScript: false,
	script: null,
	wrapperWords: [...run.wrapperWords],
	chdirs: [...run.chdirs],
	unread: [...run.unread],
	watched: run.watched,
	scripted: run.scripted,
	pending,
});

/** @param {string} w @param {string[]} flags */
const resetsEnv = (w, flags) =>
	w === "sudo" ||
	(w === "env" &&
		flags.some(
			(f) => f === "-" || /^-[^-]*[iu]|^--(?:ignore-env|unset)/.test(f),
		));

/**
 * @typedef {object} Strip
 * @property {string[]} ws
 * @property {string[]} judged
 * @property {boolean} inEnv
 * @property {boolean} envReset
 * @property {string[]} wrapperWords
 * @property {Chdir[]} chdirs
 * @property {string[]} unread
 * @property {boolean} watched
 * @property {Unwrapped[]} pending
 * @property {boolean} execs
 * @property {boolean} awaitsScript
 * @property {string | null} script
 * @property {boolean} scripted
 */

/**
 * @param {Strip} st
 * @param {string} first
 * @param {string[]} spans
 * @returns {"next" | "done" | "cut"}
 */
function stripOne(st, first, spans) {
	const { text } = literal(first, spans);
	if (st.inEnv && text.includes("=")) {
		st.wrapperWords.push(ASSIGNMENT_RE.test(first) ? first : text);
		st.ws = st.ws.slice(1);
		return "next";
	}
	const w = ASSIGNMENT_RE.test(text) ? text : afterSlash(text);
	if (w === "bg-run.sh") {
		if (st.ws[1] !== "run" || st.ws.length < 3) return "done";
		st.inEnv = false;
		st.ws = st.ws.slice(3);
		return "next";
	}
	const wrapper = WRAPPERS.get(w);
	if (!wrapper || st.judged.includes(w)) return "done";
	st.inEnv = w === "env" || w === "sudo";
	st.ws = st.ws.slice(1);
	const flagged = st.ws;
	if (!sweepFlags(st, wrapper, spans)) return "cut";
	const flags = flagged.slice(0, flagged.length - st.ws.length);
	st.envReset ||= resetsEnv(
		w,
		flags.map((f) => literal(f, spans).text),
	);
	if (st.ws.length < wrapper.positionals) return "cut";
	st.ws = st.ws.slice(wrapper.positionals);
	return stepAfterFlags(st, wrapper, spans);
}

/**
 * @param {Strip} st
 * @param {WrapperGrammar} wrapper
 * @param {string[]} spans
 * @returns {"next" | "cut"}
 */
function stepAfterFlags(st, wrapper, spans) {
	const [head, ...tail] = st.ws;
	/** @param {string[]} ws */
	const read = (ws) => ws.map((w) => literal(w, spans).text).join(" ");
	if (wrapper.command === "flock-command" && head !== undefined) {
		const f = literal(head, spans).text;
		if (f === "-c" || f === "--command") {
			const [string] = tail;
			if (string === undefined) {
				st.awaitsScript = true;
				return "cut";
			}
			st.script = read([string]);
			runScript(st, st.script, spans);
		}
	}
	if (wrapper.command === "sh-string") {
		st.watched = true;
		if (st.ws.length === 0) {
			st.awaitsScript = !st.execs;
			return "cut";
		}
		if (!st.execs) {
			st.script = read(st.ws);
			runScript(st, st.script, spans);
		}
		if (st.ws.length === 0) return "cut";
	}
	return "next";
}

/** @param {Strip} st @param {string} script @param {string[]} spans */
function runScript(st, script, spans) {
	/** @type {Unwrapped[]} */
	const runs = parseScript(script, spans).map((cmd) => ({
		words: cmd.words,
		wrapperWords: [...st.wrapperWords, ...cmd.leading],
		chdirs: [
			...st.chdirs,
			...cmd.chdirs.map((cd) => (st.envReset ? { ...cd, envReset: true } : cd)),
		],
		unread: [...st.unread, ...cmd.unread],
		watched: st.watched,
		scripted: true,
		...(st.envReset && { envReset: /** @type {const} */ (true) }),
	}));
	const [first, ...later] = runs;
	st.ws = first?.words ?? [];
	st.scripted = true;
	if (first)
		Object.assign(st, {
			wrapperWords: first.wrapperWords,
			chdirs: first.chdirs,
			unread: first.unread,
		});
	st.pending.unshift(...later);
}

/**
 * @param {Strip} st
 * @param {WrapperGrammar} wrapper
 * @param {string[]} spans
 */
function sweepFlags(st, wrapper, spans) {
	for (let raw = st.ws[0]; raw !== undefined; raw = st.ws[0]) {
		const f = literal(raw, spans).text;
		if (!f.startsWith("-") || (f === "-" && !wrapper.splits)) break;
		if (f === "--") {
			st.ws = st.ws.slice(1);
			break;
		}
		const { options, taken, read } = scanWrapperFlag(
			wrapper,
			[raw, st.ws[1]],
			spans,
		);
		st.ws = st.ws.slice(1 + taken);
		for (const option of options)
			if (!takeOption(st, wrapper, option, read)) return false;
	}
	return true;
}

/**
 * @param {Strip} st
 * @param {WrapperGrammar} wrapper
 * @param {WrapperOption} option
 * @param {boolean} read
 */
function takeOption(st, wrapper, { kind, name, value }, read) {
	if (kind === "dangling") return false;
	if (wrapper.command === "sh-string" && (name === "-x" || name === "--exec"))
		st.execs = true;
	if (kind !== "opt") return true;
	if (wrapper.splits && (name === "-S" || name === "--split-string"))
		st.ws = [...splitEnvString(value), ...st.ws];
	else if (name === wrapper.chdir || name === "--chdir")
		st.chdirs.push({ dir: value, read, holds: "always" });
	return true;
}

/**
 * @param {string[]} words
 * @param {string[]} spans
 * @returns {{ sub: string, args: string[] }[]}
 */
const gitWords = (words, spans) =>
	unwrap(words, spans).flatMap((run) => {
		const git = gitRunWords(run.words, spans);
		return git ? [git] : [];
	});

/**
 * @param {string[]} words
 * @param {string[]} spans
 * @returns {(import("./shell-words.js").GhCall & { wrapperWords: string[] })[]}
 */
const ghWords = (words, spans) =>
	unwrap(words, spans).flatMap(({ words: ws, wrapperWords }) => {
		const gh = dispatchingGhCall(ws, spans);
		return gh ? [{ ...gh, wrapperWords }] : [];
	});

/** @param {string[]} words @param {string[]} spans @returns {string[][]} */
const commitPathsArgs = (words, spans) =>
	unwrap(words, spans).flatMap((run) => {
		const args = nodeScriptArgs(run.words, spans, "commit-paths.js");
		return args ? [args] : [];
	});

module.exports = {
	unwrap,
	unwrapArgv,
	wrapperScript,
	gitWords,
	ghWords,
	commitPathsArgs,
	parseCommand,
	escapeShield,
	walkCommands,
	TEXT_ONLY_PORTS,
	unmask,
	asWritten,
	normAbs,
	walkGit,
	unsetText,
	BASH_SPACE: SPACE,
};
