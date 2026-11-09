/*
 * shell-parse.js — the guard parser's first half in Node (#2784, programme
 * #2733): given one opaque shell string from a Bash tool call, which commands
 * does it run, with which words, redirections and write targets, in which
 * directory?
 *
 * A CORE: it does no I/O. The variables a word may expand through and the
 * directory test `cp` needs arrive as ports; the guard's entry wires the real
 * ones (lib/guard-entry.js).
 *
 * Each behaviour here carries the ticket that set it.
 *
 * FAIL OPEN is the house rule (mantahostels#103 §6): a word this file cannot read
 * comes back unresolved — null, or an empty path — and the guard decides what
 * that costs. Nothing here ever runs the text.
 */

const {
	QUOTED,
	hasExpansion,
	isBareSpan,
	readSentinels,
	literal,
	unwrap,
	commandName,
	isGitValueOption,
} = require("./shell-words.js");
const { expandTildeWord } = require("./home-path.js");
const { endRun, trimEndRun } = require("./trim-run.js");
const { Lexer, SPACE } = require("./shell-lexer.js");
const {
	CONFIG_FILE_VARS,
	UNREAD_ALIAS,
	emptyAliasTable,
	isAliasKey,
	expandAlias,
	defineFromEnv,
	defineFromConfigEnvWord,
	defineFromConfigWord,
} = require("./git-alias.js");

/** The flatten's subshell marker, standing a bracket on a line of its own so a
 * walk can end a subshell's `cd` at its `)` (mantahostels#3453). */
const SCOPE_MARK = "\x02";

/** Opens a flattened line with the code of the operator before it (#4009). */
const OP_MARK = "\x05";

/**
 * The command names whose line the logical-line join refuses to absorb.
 *
 * IT STAYS AT `git` AND `gh` (mantahostels#1818 tried wider and reverted it, and
 * mantahostels#2346 made the ruling a gate): the deny guards are safe here only because a
 * line they refuse begins with one of these, and a wider list exposes quoted
 * prose as commands.
 */
const GUARDED_HEADS = ["git", "gh"];

/** A word as `read -ra` splits it: on runs of IFS whitespace. */
const IFS_SPLIT = /[ \t\n]+/;

/** A redirection operator, and the text before it with every `\`-escaped
 * character kept (#1488). */
const REDIRECT_RE = /^((?:\\.|[^\\<>])*)([<>].*)$/s;

/** @param {string} p */
const basename = (p) => p.slice(p.lastIndexOf("/") + 1);

/**
 * A path a verdict can be built on: nothing unexpanded and no blanked span.
 * @param {string} s
 */
const isResolvable = (s) => s !== "" && !hasExpansion(s) && !s.includes(QUOTED);

/**
 * Blank every quoted span out of `text` on `lx`, reset first.
 * @param {Lexer} lx
 * @param {string} text
 */
function maskText(lx, text) {
	lx.reset();
	text.split("\n").forEach((line, i) => {
		if (i) lx.lex("\n");
		lx.lex(line);
	});
	return lx.masked();
}

/**
 * Break masked text into the segments it runs, one per line. A subshell or a
 * command substitution splits too, so neither can hide a command behind its
 * bracket; given `mark`, each bracket also stands on a line of its own behind
 * SCOPE_MARK. A backtick pair splits as the `$(…)` it means (#3375). The `&`
 * and `|` of a redirection — `>&`, `<&`, `&>`, `&>>`, `>|` — are shielded from
 * the split (#1488).
 *
 * RESIDUAL: an unclosed backtick opens a subshell that never closes, so a `cd`
 * after it is undone at no `)`.
 *
 * The text this returns ends in a newline. Given `ops`, each line an operator
 * opens starts with OP_MARK and its code, which parseJoins takes off.
 * @param {string} text
 * @param {boolean} [mark]
 * @param {boolean} [ops]
 */
function flatten(text, mark = false, ops = false) {
	let inBackticks = false;
	/** @param {string} code */
	const join = (code) => (ops ? `\n${OP_MARK}${code}` : "\n");
	return `${text
		/* The lexer writes an escape as a `\`-pair, so a pair is never a
		 * backtick of its own. */
		.replace(/\\[\s\S]|`/g, (m) => {
			if (m !== "`") return m;
			inBackticks = !inBackticks;
			return inBackticks ? "$(" : ")";
		})
		.replace(/&&/g, join("a"))
		.replace(/\|\|/g, join("o"))
		.replace(/([<>])&/g, "$1\x03")
		.replace(/&>/g, "\x03>")
		.replace(/>\|/g, ">\x04")
		.replace(/[()]/g, (b) =>
			mark
				? `\n${SCOPE_MARK}${b}\n${ops && b === "(" ? `${OP_MARK}(` : ""}`
				: "\n",
		)
		.replace(/;/g, join("s"))
		.replace(/\|/g, join("p"))
		.replace(/&/g, join("b"))
		.replaceAll("\x03", "&")
		.replaceAll("\x04", "|")}\n`;
}

/**
 * What joins each of `masked`'s flattened lines to the one before: "a" `&&`, "o"
 * `||`, "s" `;`, "p" `|`, "b" `&`, "(" a bracket's opening, "" a newline or
 * nothing. A blank line hands its operator on, as `&&` at a line's end does.
 * @param {string} masked
 * @returns {string[]} one per line of flatSegments
 */
function parseJoins(masked) {
	let carry = "";
	return flatten(masked, true, true)
		.split("\n")
		.map((line) => {
			const code = line.startsWith(OP_MARK) ? line.charAt(1) : "";
			if (line.slice(code ? 2 : 0).trim() === "") {
				carry ||= code;
				return code;
			}
			const joined = code || carry;
			carry = "";
			return joined;
		});
}

/**
 * @typedef {object} CommandWords
 * @property {string[]} words the segment's words, redirections taken out
 * @property {number} wi where the command starts
 * @property {number} assignEnd where the leading assignments stop, before any
 *   `exec`
 * @property {RedirectEntry[]} redirs one per redirection taken out
 * @property {boolean} ran whether the segment runs a command
 */

/**
 * @typedef {object} RedirectEntry one redirection as written (#2785)
 * @property {string} fd the descriptor as written: digits, a `{name}`, the
 *   `&` of `&>`, or ""
 * @property {string} op the operator
 * @property {string} target masked as the command's words are
 */

/**
 * Take the redirections out of `words` (#1488): one entry per redirection,
 * the target masked as the words are. A word carrying an operator part-way —
 * `echo hi>out` — is cut there, as bash cuts it; a leading run of digits or a
 * `{name}` is the descriptor. An operator with no target left, or one whose
 * target is a process substitution, is dropped unrecorded.
 *
 * Not inside `[[ … ]]`, where `>` and `<` compare strings, nor in arithmetic
 * (`noRedirects`). `[` and `test` get no such exemption: bash redirects there.
 * @param {string[]} words
 * @param {boolean} noRedirects
 */
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

/**
 * Does the segment reach a `]]` before any `[[`? A `&&` inside `[[ … ]]`
 * splits it, so such a segment is the conditional's tail.
 * @param {string[]} words
 */
function isConditionalTail(words) {
	for (const w of words) {
		if (w === "[[") return false;
		if (w === "]]") return true;
	}
	return false;
}

/** The redirection operators, longest first so a prefix never wins. */
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
 * Cut every redirection out of one word, `words[start - 1]`, pushing what is
 * left of it to `out` and each redirection to `redirs`. Returns the index of
 * the next word to read: past a target taken from the word after, or the end
 * where an operator's target is missing or a process substitution.
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

/**
 * Split a redirection off the text `pre` before it: the descriptor — a
 * leading run of digits, a `{name}`, or the `&` of `&>` — and the operator.
 * A `pre` that is no descriptor is a word of its own, pushed to `out`.
 * @param {string} before
 * @param {string} from the text from the operator on
 * @param {string[]} out
 */
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
 * An operator's target: the text glued after it, up to any further operator
 * (`w`, still to cut), else the next word. Null where it has none to record.
 * @param {string} rest the text after the operator
 * @param {string[]} words
 * @param {number} i the next word's index
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
	/* `2> >(tee e)` and `< <(ls)`: the target is a process substitution, whose
	 * own bare operator the flatten left last. */
	if ((target === "<" || target === ">") && i + 1 === words.length) return null;
	return { target, w: "", next: i + 1 };
}

/**
 * Split one segment into its words and find the word the command starts at.
 *
 * Skipped in shell's own order (#1013): any run of reserved words, then the
 * assignments, then an `exec` and its flags. A word after `exec` is the
 * command even where it looks like an assignment. `case` arms and function
 * bodies stay unread. Given `bare`, only the assignments are skipped: the line
 * join asks that way, because skipping a reserved word there turns a prose
 * line opening `if git …` into a command (mantahostels#1818's trade).
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
		return { words, wi: 0, assignEnd: 0, redirs, ran: false };
	let wi = bare ? 0 : skipReserved(words, 0);
	while (wi < words.length && /^[A-Za-z_].*=/s.test(words[wi] ?? "")) wi++;
	const assignEnd = wi;
	if (!bare) wi = skipExec(words, wi);
	return { words, wi, assignEnd, redirs, ran: wi < words.length };
}

/** The reserved words a command may follow; `time` is read apart, for its
 * flags. */
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

/**
 * The index past any run of reserved words from `start`, a `time` taking its
 * `-p` and `--` with it.
 * @param {string[]} words
 * @param {number} start
 */
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

/**
 * The index past an `exec` at `start` and its flags, `-a` taking its value
 * with it; `start` itself where no `exec` stands there.
 * @param {string[]} words
 * @param {number} start
 */
function skipExec(words, start) {
	if (words[start] !== "exec") return start;
	let wi = start + 1;
	while ((words[wi] ?? "").startsWith("-")) {
		if ((words[wi] ?? "").endsWith("a")) wi++;
		wi++;
	}
	return wi;
}

/**
 * Collapse `.`, `..` and doubled slashes, so two spellings of one absolute
 * path compare equal as strings (mantahostels#3315). Textual, never
 * symlink-resolved: session-arbiter.js's claimKey is lexical too. One
 * line only, as the bash reader's `read`.
 * @param {string} p
 */
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

/** @param {string} kind a redirection kind */
const isWriteRedirect = (kind) =>
	["truncate", "clobber", "append", "read-write"].includes(kind);

/**
 * @typedef {object} Parsed
 * @property {string} subject the field as the payload carried it
 * @property {string[]} spans every quoted span blanked, quote character first
 * @property {string} masked the subject with quoted spans blanked, heredoc
 *   bodies out and every separator kept, before the flatten (#2710)
 * @property {number[]} heredocLines the subject's lines, numbered from 0, a
 *   heredoc's body or terminator fills (#2384)
 * @property {string[]} segments the flattened segments, one command each,
 *   with SCOPE_MARK lines for the brackets: `\x02(` and `\x02)`
 * @property {number} conditional the segment index of the first after the
 *   subject's first `||` outside a quoted span, or -1 where it has none (#328)
 * @property {string[]} joins parseJoins's code for each segment (#4009); a lifted
 *   substitution's is "("
 */

/**
 * Parse one Bash command string.
 *
 * Quoted spans are blanked FIRST, and heredoc openers then detected on the
 * blanked text, so `echo "a << b"` opens no heredoc; a quoted delimiter is read
 * back off the original line. A heredoc body is data, not commands, and is
 * dropped (mantahostels#201).
 *
 * Then the lines are masked again over LOGICAL lines (mantahostels#182): a quote the lexer
 * leaves open takes the next line too, so a multi-line message stays one
 * segment. The join is ABANDONED the moment it would absorb a line that runs
 * a GUARDED_HEADS command — the lexer is not the whole of shell, and joining on
 * a stray quote would hide every line after it — EXCEPT inside a message
 * argument (mantahostels#232), whose lines are prose.
 *
 * Each command substitution a double-quoted span runs is LIFTED into segments
 * of its own, bracketed as a subshell, ahead of the segment holding the span
 * (#3375): it runs before that command does.
 * @param {string} subject
 * @returns {Parsed}
 */
function parseCommand(subject) {
	/** @type {string[]} */
	const spans = [];
	const { masked, heredocLines } = maskSubject(subject, spans);
	/* Read BEFORE the flatten turns every `||` into a newline. The text before
	 * the first one flattens to exactly the segments ahead of it. */
	const before = masked.includes("||")
		? (flatten(masked.slice(0, masked.indexOf("||")), true).match(/\n/g)
				?.length ?? 0)
		: -1;
	/** @type {string[]} */
	const segments = [];
	/** @type {string[]} */
	const joins = [];
	const lineJoins = parseJoins(masked);
	let conditional = -1;
	flatSegments(masked).forEach((segment, i) => {
		if (i === before) conditional = segments.length;
		const lifted = withLifted(segment, spans);
		segments.push(...lifted);
		const join = lineJoins[i];
		if (join === undefined) throw new Error("a segment with no join");
		joins.push(...lifted.slice(1).map(() => "("), join);
	});
	if (before >= 0 && conditional < 0) conditional = segments.length;
	return { subject, spans, masked, heredocLines, segments, conditional, joins };
}

/**
 * `subject` masked, and the lines its heredoc bodies fill.
 * @param {string} subject
 * @param {string[]} spans accumulator: the subject's spans are appended
 */
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

/**
 * `segment`, behind the segments its quoted substitutions run.
 * @param {string} segment
 * @param {string[]} spans accumulator: each lifted command's spans are
 *   appended
 */
const withLifted = (segment, spans) => [
	...liftSubstitutions(segment, spans),
	segment,
];

/**
 * The segments the command substitutions in `segment`'s double-quoted spans
 * run, each bracketed by SCOPE_MARK lines, their own lifted first.
 * @param {string} segment
 * @param {string[]} spans accumulator: each lifted command's spans are
 *   appended
 * @returns {string[]}
 */
function liftSubstitutions(segment, spans) {
	/** @type {string[]} */
	const lifted = [];
	readSentinels(segment, (_lit, idx) => {
		const span = idx === null ? undefined : spans[idx];
		if (span === undefined) return { text: "", stepPast: true };
		for (const inner of quotedSubstitutions(span)) {
			const { masked } = maskSubject(inner, spans);
			lifted.push(`${SCOPE_MARK}(`);
			for (const seg of flatSegments(masked))
				lifted.push(...withLifted(seg, spans));
			lifted.push(`${SCOPE_MARK})`);
		}
		return { text: "", stepPast: true };
	});
	return lifted;
}

/**
 * The text of each `$(…)` and backtick pair a recorded span runs at its own
 * level — none unless it is double-quoted. A `$((`
 * is arithmetic and skipped. A backtick pair's `\$`, `` \` ``, `\\` and
 * `\"` lose their backslash, as bash reads them there.
 * @param {string} span as recorded, its opening quote first
 */
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
 * Read on from `i` in a double-quoted span: where to read on from, -1 where
 * a substitution never closes, and the text of one that ends there.
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

/**
 * The index of the backtick closing one opened before `from`, or -1.
 * @param {string} text
 * @param {number} from
 */
function backtickEnd(text, from) {
	for (let j = from; j < text.length; j++) {
		const c = text.charAt(j);
		if (c === "`") return j;
		if (c === "\\") j++;
	}
	return -1;
}

/**
 * The subject's command lines, `\`-newlines joined and heredoc bodies out,
 * and the lines, numbered from 0, those bodies fill (#2384).
 * @param {string} subject
 * @param {Lexer} lx
 */
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
		/* A `\`-newline outside `'…'` or `$'…'` is no break to bash, so the line
		 * is held and the next joined onto it (#490). */
		const line = held + raw;
		held = "";
		if (isLineContinued(lx, line)) {
			held = line.slice(0, -1);
			return;
		}
		lx.lex("\n");
		term = parseHeredocTerm(lx.out, line);
		/* An opener ends the carry: a quote after the `<<` would otherwise stay
		 * open across the skipped body and blank every line after it. */
		if (term) lx.reset();
		commandLines.push(line);
	});
	if (held) commandLines.push(held);
	return { commandLines, heredocLines };
}

/**
 * Lex one line; true where it ends in a `\`-newline outside `$'…'`, to be
 * joined onto the next, the lexer then set back to where it stood.
 * @param {Lexer} lx
 * @param {string} line
 */
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

/**
 * The terminator a line's heredoc opener names, or "". Read on the masked
 * line, so a `<<` inside quotes opens nothing; a quoted delimiter is read back
 * off the original line.
 * @param {string} mask
 * @param {string} line
 */
function parseHeredocTerm(mask, line) {
	const opener = /<<-?[ \t\n\v\f\r]*\\?([A-Za-z_][A-Za-z0-9_]*)/.exec(mask);
	const quoted = mask.includes("<<")
		? /<<-?[ \t\n\v\f\r]*['"]([A-Za-z_][A-Za-z0-9_]*)/.exec(line)
		: null;
	return opener?.[1] ?? quoted?.[1] ?? "";
}

/**
 * Mask the command lines over LOGICAL lines (mantahostels#182), one masked
 * entry per logical line, abandoning a join that would absorb a GUARDED_HEADS
 * line outside a message argument (mantahostels#232). The abandon is the
 * fail-closed read of a quote typed by mistake: a stray apostrophe that a
 * later line's quote closes would hide every command between them. A quote
 * opening a message argument was meant, so only there does the join hold.
 * @param {string[]} commandLines
 * @param {Lexer} lx
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
	/* Whether the open quote is a message is asked once per span. */
	let messageAt = "";
	let prose = false;
	lx.reset();
	for (const line of commandLines) {
		if (pending.length > 0) {
			const at = `${lx.opens}${lx.frames ? "open" : ""}`;
			if (messageAt !== at) {
				messageAt = at;
				prose = isMessageOpen(lx);
			}
			if (!prose && isCommandAbsorbed(line, spans)) {
				pending.push(line);
				keepPerLine();
				continue;
			}
			/* The join point is inside the quote still open, so the newline lands
			 * in a span — kept, because the lexer reads a heredoc's terminator
			 * line by it. */
			lx.lex("\n");
		}
		pending.push(line);
		lx.lex(line);
		if (lx.open()) continue;
		kept.push(lx.out);
		pending = [];
		lx.reset();
	}
	/* A quote that never closed was not a multi-line string — a stray
	 * apostrophe in a comment is the ordinary case. */
	keepPerLine();
	return kept;
}

/**
 * Does `line`, read on its own, run a GUARDED_HEADS command? Every segment is
 * checked, not just the head word: `foo; git checkout -b evil` hides one.
 * Masked on a lexer of its own.
 * @param {string} line
 * @param {string[]} spans
 */
function isCommandAbsorbed(line, spans) {
	const masked = maskText(new Lexer(spans), line);
	for (const seg of masked.replace(/[;&|()]/g, "\n").split("\n")) {
		const { words, wi, ran } = commandWords(seg, { bare: true });
		if (ran && GUARDED_HEADS.includes(basename(words[wi] ?? ""))) return true;
	}
	return false;
}

/**
 * Is the lexer's still-open quote the argument of a flag whose value is DATA —
 * a commit message, an issue body — so the lines that follow are prose
 * (mantahostels#232)? Narrow on the word the quote opens on: `-m` or
 * `--message` on any command, so `commit-paths.js -m` reads as `git commit -m`
 * does (#4028), and `gh`'s body and title flags on `gh`. Not keyed on the
 * subcommand: a quoted argument is data whatever the subcommand.
 * Residual: `-m` is a count or mode on `grep`, `sort`, `mkdir` and others, so
 * a quote opened after one there keeps its join through a `git` line too.
 * @param {Lexer} lx
 */
function isMessageOpen(lx) {
	if (!lx.frames) return false;
	const lines = flatten(lx.prefix).split("\n");
	const last = lines.at(-2) ?? "";
	const { words, wi, ran } = commandWords(last);
	if (!ran) return false;
	/* `--message="…` arrives glued to its `=`. */
	const word = (words.at(-1) ?? "").replace(/[=]$/, "");
	if (word === "-m" || word === "--message") return true;
	return (
		basename(words[wi] ?? "") === "gh" &&
		["-b", "--body", "-t", "--title"].includes(word)
	);
}

/**
 * A flattened segment for a human: every blanked span shown as `"…"`, and the
 * leading whitespace the flattening leaves dropped. A sentinel without an
 * index is not something this file writes, so it is rendered and left alone.
 * A sentinel byte the command typed shows as `"…"` too: this reads no spans.
 * @param {string} segment
 */
function unmask(segment) {
	const { out, rest } = readSentinels(segment, (lit, idx) => ({
		text: `${lit}"…"`,
		stepPast: idx !== null,
	}));
	return (out + rest).replace(/^[ \t\n\v\f\r]+/, "");
}

/**
 * Masked text as typed, each blanked span back inside its own quotes, for a
 * guard handing a command back to be re-issued (#519). A span index never
 * recorded is written `<quoted>` rather than guessed. One pass: a span holds
 * its text as typed, so a sentinel inside one was typed (#4278).
 * @param {string} text
 * @param {string[]} spans
 */
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
 * @typedef {object} Scope what a word resolves against
 * @property {string[]} spans
 * @property {Map<string, string>} locals the command's own assignments,
 *   resolved (mantahostels#208)
 * @property {Set<string>} dead names it assigned a value this file will not
 *   resolve, or two different values
 * @property {Record<string, string | undefined>} vars the guard's own
 *   variables, the environment the hook inherited
 * @property {string} subject the whole command, searched for a name's other
 *   mentions under emptyUnset (#325)
 * @property {number} conditional Parsed's
 * @property {boolean} emptyUnset a git walk's opt-in (#310): a name provably
 *   empty is substituted empty rather than refused
 * @property {string[]} emptyNames the unset names the last pathArg read as
 *   empty
 */

/**
 * `$VAR` and `${VAR}` in `s` expanded, the command's own assignments winning
 * over the environment as in shell (mantahostels#208, correcting mantahostels#183); null where the text
 * cannot be resolved.
 *
 * DELIBERATELY NARROW. It refuses, rather than guessing, on command
 * substitution, every `${VAR<operator>…}` form, an unset or empty variable,
 * and a value carrying whitespace or a shell metacharacter. A name the command
 * assigned in a way this file will not resolve never falls back to the
 * environment: the command overwrote it.
 * @param {string} text
 * @param {Scope} scope
 * @returns {string | null}
 */
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

/**
 * The name a `$` opens, `{…}`-braced or bare, and the text after it; null
 * where neither form follows.
 * @param {string} s the text after the `$`
 */
function parseVarRef(s) {
	if (s.startsWith("{")) {
		const close = s.indexOf("}");
		if (close < 0) return null;
		return { name: s.slice(1, close), rest: s.slice(close + 1) };
	}
	const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s);
	if (!m) return null;
	return { name: m[0], rest: s.slice(m[0].length) };
}

/**
 * The value `name` expands to, the command's own assignments winning; null
 * where it is refused.
 * @param {string} name
 * @param {Scope} scope
 */
function lookupVar(name, scope) {
	/* Anything but a bare name — ${VAR:-x}, ${#VAR}, ${!VAR}, $1 — is
	 * refused. */
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || scope.dead.has(name))
		return null;
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

/** A command that can assign a name without the text naming it (#325
 * review). */
const SOURCING_RE =
	/(?:(?:^|[;&|(]|then|do|else)[ \t\n\v\f\r]*|\n[ \t\v\f\r]*)(source|\.|eval)[ \t\n\v\f\r]/;

/**
 * Under a git walk's emptyUnset opt-in (#325), is `$<name>` empty for certain,
 * so lookupVar substitutes it rather than refusing? The caller has already
 * found the name unset in the environment and unharvested (`allowed` 0), or
 * harvested as empty (`allowed` 1). Either is certain only where the command
 * assigns it NOWHERE ELSE: the harvest sees leading `NAME=` words alone, so an
 * `export W=…`, `read W` or `for W in` must stop it. Any bare-word mention past
 * the count refuses — a heredoc or a quoted string naming it included, which
 * fails open where it need not. A command carrying `||` may skip an assignment
 * the count cannot tell from a use, and one running `source`, `.` or `eval`
 * can assign without naming it, so both refuse outright.
 *
 * An unset name is recorded in `scope.emptyNames`; one this command emptied
 * itself needs no telling that variables do not carry between calls.
 *
 * RESIDUAL (#310's Q2): a name the Bash tool's shell holds and the hook's
 * environment lacks — an unexported ~/.bashrc variable — reads as unset here,
 * so the guard judges the cwd where the command runs elsewhere.
 * @param {string} name
 * @param {number} allowed
 * @param {Scope} scope
 */
function isProvablyEmpty(name, allowed, scope) {
	const { subject } = scope;
	if (!scope.emptyUnset || scope.conditional >= 0) return false;
	if (SOURCING_RE.test(subject)) return false;
	let mentions = 0;
	for (
		let at = subject.indexOf(name);
		at >= 0;
		at = subject.indexOf(name, at + name.length)
	) {
		const before = subject.slice(0, at);
		const after = subject.slice(at + name.length);
		if (/[A-Za-z0-9_]$/.test(before) || /^[A-Za-z0-9_]/.test(after)) continue;
		/* A plain reference — `$W` or `${W}` — assigns nothing. */
		if (before.endsWith("$") || before.endsWith("${")) continue;
		if (++mentions > allowed) return false;
	}
	if (!allowed) scope.emptyNames.push(name);
	return true;
}

/**
 * One path argument — a `cd` target, a redirect target, a word — resolved:
 * `{ path }`, `{ empty: true }` where it resolved fully to the EMPTY STRING
 * (only a quoted `""` can, and `cd ""` stays put, #301), or null where it stays
 * unresolved. The unset names it read as empty land in `scope.emptyNames`
 * (#325). The word arrives masked, so a fully literal `cd "/abs"` reaches
 * here as a sentinel and is read back through `spans` (mantahostels#183).
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
	/* Only a quoted word survives expanding to nothing: unquoted, bash drops
	 * it, so `cd $W` with W empty is a bare `cd` (#325). */
	return raw.includes(QUOTED) ? { empty: true } : null;
}

/**
 * An unquoted leading `~` is the shell's to expand (mantahostels#3453); `~user`
 * is refused, not looked up. Null where it will not expand.
 * @param {string} word
 * @param {Scope} scope
 */
function expandTilde(word, scope) {
	if (!word.startsWith("~")) return word;
	return expandTildeWord(word, expandVars("$HOME", scope));
}

/**
 * A masked word with every span read back through `scope.spans` and every
 * variable expanded, or null where any part will not resolve.
 * @param {string} raw
 * @param {Scope} scope
 */
function expandMasked(raw, scope) {
	/* Once a part fails nothing after it is read: an expansion records the
	 * names it read as empty (#325). */
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

/**
 * A recorded span's text as the shell reads it: a `"…"` span expanded, a
 * `'…'` span literal; null where it will not resolve.
 * @param {string} recorded the span, quote character first
 * @param {Scope} scope
 */
function expandSpan(recorded, scope) {
	/* A bare span is typed text outside quotes, read back as typed (#4278). */
	if (isBareSpan(recorded)) return recorded;
	const span = recorded.slice(1);
	if (recorded.charAt(0) === '"') return expandVars(span, scope);
	/* Single quotes are literal, so a `$` inside one names a directory rather
	 * than an expansion. Refused rather than guessed at. */
	if (recorded.charAt(0) !== "'" || hasExpansion(span)) return null;
	return span;
}

/**
 * A word as the shell would expand it, or null where any part will not
 * resolve — a quoted `""` included. Relative stays relative.
 * @param {string} word
 * @param {Scope} scope
 */
function resolveWord(word, scope) {
	const r = pathArg(word, scope);
	return r && "path" in r ? r.path : null;
}

/**
 * @typedef {object} Redirect
 * @property {string} fd as written, else 1 for an output and 0 for an input;
 *   `&` for `&>`, `&>>` and `>&<file>`, which send both 1 and 2
 * @property {string} kind truncate, clobber, append, read, read-write, copy,
 *   close, here-string or heredoc
 * @property {string} target as written, masked as the command's words are
 * @property {string} path the target as an absolute path, through the walk's
 *   cwd; "" where it will not resolve, and always for copy, close,
 *   here-string and heredoc
 */

/**
 * @typedef {object} WriteTarget
 * @property {"write" | "move-source" | "delete"} mode
 * @property {string} route redirect, or the command as the table in
 *   writeTargets names it (#2142)
 * @property {string} target as written, masked — `<dest>/<basename>` for a
 *   copy into a directory
 * @property {string} path absolute, through the walk's cwd; "" where it will
 *   not resolve
 */

/**
 * @typedef {object} Command one command a walk hands its callback
 * @property {string} segment the flattened segment, masked
 * @property {string[]} words the command's own words, leading assignments and
 *   every redirection removed (#1488)
 * @property {string[]} leading the words before the command — reserved words
 *   and the leading assignments (#1013)
 * @property {string} cwd the directory it runs in; "" where the walk cannot
 *   know it, which the caller records before it fails open (mantahostels#3453)
 * @property {() => Redirect[]} redirects
 * @property {(words?: string[]) => WriteTarget[]} writeTargets
 * @property {(word: string) => string | null} resolveWord
 * @property {(name: string) => boolean} assigned whether the command assigned
 *   `name`, before this point, a value the walk resolves (#2436)
 */

/**
 * @typedef {object} WalkPorts
 * @property {string | undefined} cwd the payload's `.cwd`, where the session's
 *   shell stands (mantahostels#2682)
 * @property {string} fallbackCwd the hook's own directory, for a payload
 *   carrying no absolute cwd
 * @property {Record<string, string | undefined>} vars what an unassigned
 *   `$VAR` reads
 * @property {(path: string) => boolean} isDir
 * @property {boolean} [bareRedirects] also hand over a segment that is
 *   redirections alone — `> out`, `exec 3> log` — with no words
 */

/**
 * Ports for a walk that judges the text alone: no payload cwd, no
 * environment, no filesystem.
 * @type {WalkPorts}
 */
const TEXT_ONLY_PORTS = Object.freeze({
	cwd: undefined,
	fallbackCwd: "/",
	vars: {},
	isDir: () => false,
});

/**
 * @typedef {Map<string, string | null>} GitEnv each git-reading variable's raw
 *   value word, null where the command's handling of it cannot be read
 */

/**
 * @typedef {object} Walk one walk's running state over a parse's segments
 *   (#2785): the cwd through `cd`, the subshell stack, arithmetic's redirect
 *   switch and the command's own assignments. Each walk keeps
 *   its own, so a walk from inside a callback disturbs nothing.
 * @property {Parsed} parsed
 * @property {Scope} scope
 * @property {string} cwd "" where the walk cannot know it
 * @property {string[]} cwdNames the unset names read as empty on the way to
 *   the cwd (#325)
 * @property {string} cwdLost the words of the command that made the cwd
 *   unknown, for the unresolved-tree record (#320)
 * @property {string[]} cwdDoubt where the command may still stand, a `cd` having
 *   perhaps not run or failed (#4009)
 * @property {string[]} cwdPending the same, held while a `&&` chain off that
 *   `cd` runs only if it worked
 * @property {boolean} aliasWritten a `git config` earlier in the command touched
 *   an alias (#4009)
 * @property {GitEnv} gitEnv the git-reading variables an `export` has put in
 *   the environment (#3997)
 * @property {{ cwd: string, names: string[], noRedirects: boolean,
 *   gitEnv: GitEnv, cwdDoubt: string[], cwdPending: string[] }[]} stack what
 *   each open `(` restores at its `)`
 * @property {boolean} noRedirects inside arithmetic, whose `>` and `<`
 *   compare (#1488)
 * @property {string} arPrev the segment before
 * @property {string} arLast "open" after a `(`, "open-empty" after the empty
 *   line a second `(` straight after it leaves
 */

/**
 * @param {Parsed} parsed
 * @param {Record<string, string | undefined>} vars
 * @param {string} cwd where the walk starts
 * @param {boolean} emptyUnset
 * @returns {Walk}
 */
const newWalk = (parsed, vars, cwd, emptyUnset) => ({
	parsed,
	scope: {
		spans: parsed.spans,
		locals: new Map(),
		dead: new Set(),
		vars,
		subject: parsed.subject,
		conditional: parsed.conditional,
		emptyUnset,
		emptyNames: [],
	},
	cwd,
	cwdNames: [],
	cwdLost: "",
	cwdDoubt: [],
	cwdPending: [],
	aliasWritten: false,
	gitEnv: new Map(),
	stack: [],
	noRedirects: false,
	arPrev: "",
	arLast: "",
});

/**
 * Call `fn` with each segment that is no bracket's SCOPE_MARK line, its words
 * split and its leading assignments harvested — even where it runs nothing,
 * because `WT=/x && git …` flattens the assignment into a segment of its own
 * (mantahostels#208).
 * @param {Walk} walk
 * @param {(segment: string, cw: CommandWords, segIdx: number) => void} fn
 */
function eachSegment(walk, fn) {
	walk.parsed.segments.forEach((segment, segIdx) => {
		if (arithScope(walk, segment)) return;
		const cw = commandWords(segment, { noRedirects: walk.noRedirects });
		harvest(walk, cw.words.slice(0, cw.assignEnd), segIdx);
		fn(segment, cw, segIdx);
	});
}

/**
 * Whether `segment` is a bracket's SCOPE_MARK line, moving the scope where it
 * is. Arithmetic `((` and `$((` compare with `>` and `<` (#1488): each `(`
 * stacks the state its `)` restores. A `$(` opens a command, a `(` inside
 * arithmetic groups, and a second `(` straight after a first — the flatten
 * leaves exactly an empty line between — opens arithmetic.
 * @param {Walk} walk
 * @param {string} segment
 */
function arithScope(walk, segment) {
	const isOpen = segment === `${SCOPE_MARK}(`;
	const isClose = segment === `${SCOPE_MARK})`;
	if (isOpen) openScope(walk);
	else if (isClose) closeScope(walk);
	else if (segment !== "") walk.arLast = "";
	else if (walk.arLast === "open") walk.arLast = "open-empty";
	walk.arPrev = segment;
	return isOpen || isClose;
}

/** A subshell's `(`: stack the state its `)` restores.
 * @param {Walk} walk */
function openScope(walk) {
	const { cwd, cwdNames: names, noRedirects, gitEnv } = walk;
	const { cwdDoubt, cwdPending } = walk;
	walk.stack.push({ cwd, names, noRedirects, gitEnv, cwdDoubt, cwdPending });
	if (walk.arLast === "open-empty") {
		walk.noRedirects = true;
		walk.arLast = "";
		return;
	}
	if (walk.arPrev.endsWith("$")) walk.noRedirects = false;
	walk.arLast = "open";
}

/** A `)` with no `(` open is a `case` pattern, which moves nothing.
 * RESIDUAL: one inside a subshell closes that subshell early.
 * @param {Walk} walk */
function closeScope(walk) {
	const back = walk.stack.pop();
	if (back) {
		walk.cwd = back.cwd;
		walk.cwdNames = back.names;
		walk.noRedirects = back.noRedirects;
		walk.gitEnv = back.gitEnv;
		walk.cwdDoubt = back.cwdDoubt;
		walk.cwdPending = back.cwdPending;
	}
	walk.arLast = "";
}

/**
 * Record the literal assignments in `words` (mantahostels#208), each visible to the
 * commands after it alone. A name lands in `dead` — every later use
 * unresolvable — on an assignment at or after the first `||` (#328), which a
 * `||` may skip; on a value this file will not resolve; and on a second
 * assignment of a different value, as the flatten loses which arm ran.
 * @param {Walk} walk
 * @param {string[]} words
 * @param {number} segIdx
 */
function harvest(walk, words, segIdx) {
	const { conditional } = walk.parsed;
	const skipped = conditional >= 0 && segIdx >= conditional;
	for (const w of words) {
		const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(w);
		if (!m) continue;
		const val = skipped ? null : assignedValue(m[2] ?? "", walk.scope);
		recordAssignment(walk.scope, m[1] ?? "", val);
	}
}

/**
 * Move the cwd for one command's words; whether the command is one that moves
 * it. Followed: `cd <path>`, and `cd ""`, which stays put (#301). Made
 * unknown: `cd -` and any other flag, a bare `cd`, `pushd`, `popd`,
 * `builtin cd` and `command cd`. A relative move from an unknown directory
 * stays unknown.
 * @param {Walk} walk
 * @param {string[]} words
 */
function moveCwd(walk, words) {
	const [head, arg] = words;
	const lost =
		head === "pushd" ||
		head === "popd" ||
		((head === "builtin" || head === "command") && arg === "cd");
	if (lost) return loseCwd(walk, words);
	if (head !== "cd") return false;
	const r = pathArg(arg ?? "", walk.scope);
	const names = walk.scope.emptyNames;
	if (r && "empty" in r) walk.cwdNames = [...walk.cwdNames, ...names];
	else if (!r || r.path.startsWith("-")) loseCwd(walk, words);
	else if (r.path.startsWith("/")) {
		walk.cwd = r.path;
		walk.cwdNames = [...names];
	} else if (walk.cwd) {
		walk.cwd = `${walk.cwd}/${r.path}`;
		walk.cwdNames = [...walk.cwdNames, ...names];
	}
	return true;
}

/**
 * Make the cwd unknown, keeping the command that did it. RESIDUAL: not
 * stacked, so a subshell's `)` handing back an unknown cwd leaves the words of
 * a `cd` inside it.
 * @param {Walk} walk
 * @param {string[]} words
 */
function loseCwd(walk, words) {
	walk.cwd = "";
	walk.cwdNames = [];
	walk.cwdLost = words.join(" ");
	return true;
}

/**
 * A word as an absolute path through the walk's cwd, normalised; "" where it
 * will not resolve.
 * @param {Walk} walk
 * @param {string} word
 */
function absolutePath(walk, word) {
	const p = resolveWord(word, walk.scope);
	if (!p) return "";
	if (p.startsWith("/")) return normAbs(p);
	return walk.cwd ? normAbs(`${walk.cwd}/${p}`) : "";
}

/**
 * Call `fn` once per command `parsed` runs, in order. Segments that run
 * nothing are skipped, bar redirections alone under `bareRedirects`.
 *
 * Seeded from the payload's cwd, else the hook's own (mantahostels#2682). The
 * cwd is moved AFTER each callback, so a `cd`'s own callback reads the
 * directory it ran from. A subshell's `)` hands back the cwd its `(` saw.
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
	eachSegment(walk, (segment, { words, wi, assignEnd, redirs, ran }) => {
		if (!ran && !(ports.bareRedirects && redirs.length > 0)) return;
		const own = ran ? words.slice(wi) : [];
		const redirects = () => readRedirects(redirs, scope, abs);
		fn({
			segment,
			words: own,
			leading: words.slice(0, assignEnd),
			cwd: walk.cwd,
			redirects,
			writeTargets: (w = own) =>
				writeTargets(w, redirects(), {
					spans: scope.spans,
					resolveAbs: abs,
					resolve: (word) => resolveWord(word, scope),
					isDir: ports.isDir,
				}),
			resolveWord: (word) => resolveWord(word, scope),
			assigned: (name) => scope.locals.has(name),
		});
		if (ran) moveCwd(walk, own);
	});
}

/**
 * @typedef {object} GitCall one git command walkGit hands its callback
 * @property {string} segment the flattened segment, masked
 * @property {string} sub the subcommand, one the walk asked for
 * @property {string} tree the working tree it runs against; "" only under
 *   `strict`, where the tree did not resolve and may be any tree at all
 *   (#311): branch on it before any `git -C`, which answers an empty path for
 *   the hook's own cwd
 * @property {string[]} args the subcommand's own words, RAW: each still to be
 *   read through literal
 * @property {string[]} emptyVars under `emptyUnset`, each unset name read as
 *   empty on the way to `tree` (#325), once each, in order; else empty
 */

/**
 * @typedef {WalkPorts & {
 *   treeClass: (dir: string) => "shared" | "linked" | "other" | "unknown",
 *   log: (what: string, detail?: string) => void,
 *   readFileAliases?: (dir: string) => import("./git-alias.js").FileAliases | null,
 * }} GitWalkPorts `treeClass` is lib/git-tree.js's treeClassifier; `log`
 *   records a fail-open; `readFileAliases` reads the config files a tree sees, null
 *   where git could not say, and a walk without it reads none
 */

/**
 * @typedef {object} GitWalkOpts
 * @property {string[]} subs the subcommands to call back for
 * @property {string} noun what the guard would have judged, for the
 *   fail-open record
 * @property {"shared" | "repo"} scope "shared" judges this repo's shared
 *   working tree alone; "repo" a linked worktree too (mantahostels#1213), for
 *   a guard whose reason to refuse is not the shared index (mantahostels#344)
 * @property {boolean} [strict] hand an unresolved tree over as "" rather than
 *   record and skip it (#301, #311): for a guard whose target may BE the shared
 *   tree, where declining to judge allows the very command it refuses. The
 *   callback then owns the fail-open record for what it still allows
 * @property {boolean} [emptyUnset] the opt-in #310 ruled: a `cd`/`git -C`
 *   target whose every `$` is a bare name the command does not assign and the
 *   environment does not set — or one the command sets to empty — is
 *   substituted EMPTY and judged, which in quotes is the cwd. Shell state does
 *   not carry between Bash calls, so that is the tree the command runs in
 * @property {boolean} [unwrap] judge a git command behind shell-words.js's
 *   unwrap wrappers (#1731)
 */

/**
 * Call `fn` once per git invocation of one of `opts.subs` that runs against a
 * tree in `opts.scope` (mantahostels#157). Everything else is filtered out
 * here: another repo, a tree outside the scope, a subcommand the guard did not
 * ask for, and a `cd`, which moves the running cwd rather than being judged.
 *
 * The subcommand filter runs BEFORE the tree is resolved: a `git status` whose
 * tree cannot be resolved is no fail-open, because no guard was going to judge
 * it. One the guard asked for
 * whose tree will not resolve is recorded through `ports.log`, as is a tree
 * git could not answer for (mantahostels#147).
 *
 * SEEDED FROM `ports.fallbackCwd`, the hook's own directory, where walkCommands
 * seeds from the payload's.
 * @param {Parsed} parsed
 * @param {(call: GitCall) => void} fn
 * @param {GitWalkPorts} ports
 * @param {GitWalkOpts} opts
 */
function walkGit(parsed, fn, ports, opts) {
	const { subs, noun, scope, strict = false } = opts;
	const walk = newWalk(
		parsed,
		ports.vars,
		ports.fallbackCwd,
		opts.emptyUnset ?? false,
	);
	eachSegment(walk, (segment, cw, segIdx) => {
		const git = readGitSegment(walk, cw, segIdx, {
			unwrapped: opts.unwrap ?? false,
			isDir: ports.isDir,
		});
		if (!git) return;
		const { sub, args } = expandAlias(git.sub, git.args, git.aliases, {
			subs,
			readFileAliases: () =>
				ports.readFileAliases
					? ports.readFileAliases(git.named || git.tree || ports.fallbackCwd)
					: new Map(),
		});
		if (sub === "config") markAliasWritten(walk, args);
		if (!subs.includes(sub)) return;
		/* A named git directory moves the refs and leaves the work tree where the
		 * command stands, and a named work tree moves the files (measured), so
		 * each adds a tree to judge. */
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
	});
}

/**
 * Hand `call` one tree its walk judges, or record why it cannot.
 * @param {string} tree "" where it will not resolve
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
	/* "unknown" is git declining to answer for the directory, not a
	 * different tree: the guard is declining to judge a command it asked
	 * for, so it is recorded. */
	if (cls === "unknown")
		ports.log(
			`git could not answer for ${tree} — a git ${sub} there was allowed unchecked`,
		);
	else if (cls === "shared" || (opts.scope === "repo" && cls === "linked"))
		call(tree);
}

/**
 * @typedef {object} GitTarget the trees a git command reaches
 * @property {string} tree its work tree; "" where it will not resolve
 * @property {string | null} named the tree whose refs `--git-dir`, `GIT_DIR` or
 *   `GIT_COMMON_DIR` name, "" where it will not resolve; null where none does
 * @property {string | null} workTree the tree `--work-tree` or `GIT_WORK_TREE`
 *   names, "" where it will not resolve; null where none does
 * @property {string[]} doubted where the command may stand instead of `tree`
 * @property {string | null} fromCwd the relative moves its `-C`s made off the
 *   cwd, each `/`-led; null where an absolute one ended the cwd's say
 * @property {string[]} names the unset names read as empty on the way (#325)
 * @property {string} written an unresolved `-C` as typed, for the record
 * @property {import("./git-alias.js").AliasTable} aliases what the command
 *   line defines
 */

/**
 * One segment as a git command carrying a subcommand: `{ sub, args }` and the
 * tree it runs against, or null for anything else — a `cd` among them, which
 * moves the walk's cwd instead (emptying it where the target will not resolve,
 * so every later segment fails open rather than judging a worktree command
 * against the hook's own tree).
 * @param {Walk} walk
 * @param {CommandWords} cw
 * @param {number} segIdx
 * @param {{ unwrapped: boolean, isDir: (path: string) => boolean }} how
 *   `unwrapped` judges past the launcher wrappers (#1731)
 * @returns {(GitTarget & { sub: string, args: string[] }) | null}
 */
function readGitSegment(walk, { words, wi, assignEnd, ran }, segIdx, how) {
	settleCwdDoubt(walk, segIdx);
	if (!ran) {
		markRepoVarsUnread(walk, words, true);
		return null;
	}
	let own = words.slice(wi);
	if (stepCwd(walk, own, segIdx, how.isDir)) return null;
	if (trackExport(walk, own)) return null;
	let carried = words.slice(0, assignEnd);
	/** @type {string[]} */
	let chdirs = [];
	if (how.unwrapped) {
		const stripped = unwrap(own, walk.scope.spans);
		own = stripped.words;
		carried = [...carried, ...stripped.wrapperWords];
		chdirs = stripped.chdirs;
	}
	if (commandName(own[0] ?? "") !== "git") {
		markRepoVarsUnread(walk, words, false);
		return null;
	}
	const env = new Map(walk.gitEnv);
	for (const [name, value] of carried.flatMap(parseGitEnvWord))
		env.set(name, value);
	/** @type {GitTarget} */
	const target = {
		tree: walk.cwd,
		named: null,
		workTree: null,
		doubted: [],
		fromCwd: "",
		names: walk.cwdNames,
		written: "",
		aliases: emptyAliasTable(),
	};
	const { spans } = walk.scope;
	target.aliases.anyUnread = walk.aliasWritten;
	defineFromEnv(target.aliases, env, spans);
	for (const dir of chdirs) readGitDir(dir, target, walk.scope);
	const i = readGitOptions(own, target, {
		scope: walk.scope,
		env,
		isDir: how.isDir,
	});
	const word = own[i];
	if (word === undefined) return null;
	/* An absolute `-C` says where it stands whatever a `cd` did. */
	if (target.fromCwd !== null)
		target.doubted = walk.cwdDoubt.map((d) => `${d}${target.fromCwd}`);
	/* The config read follows `tree`, which the doubt says it may not stand in. */
	target.aliases.anyUnread ||= target.doubted.length > 0;
	const args = own.slice(i + 1);
	const spelt = literal(word, spans);
	/* An unread word could be any subcommand, or a `--git-dir` to any tree. */
	if (!spelt.known)
		return {
			...target,
			named: target.named ?? "",
			sub: UNREAD_ALIAS,
			args: [],
		};
	return { ...target, sub: spelt.text, args };
}

/* A segment opening a compound command, whose parts a `cd` may run in any order
 * or not at all. */
const COMPOUND_START =
	/^\s*(?:if|while|until|for|select|case|function|\{)(?:\s|$)/;

/**
 * A `&&` chain's end: from here on, a `cd` that opened it may not have worked.
 * @param {Walk} walk accumulator: its doubts are replaced
 * @param {number} segIdx
 */
function settleCwdDoubt(walk, segIdx) {
	const join = walk.parsed.joins[segIdx];
	if (join === "a" || join === "(" || walk.cwdPending.length === 0) return;
	walk.cwdDoubt = [...walk.cwdDoubt, ...walk.cwdPending];
	walk.cwdPending = [];
}

/**
 * Move the cwd for one command's words, as moveCwd does, and keep where the
 * command may still stand; whether the command is one that moves it. In a
 * pipeline or behind `&` it runs in a subshell and moves nothing (measured). A
 * move sticks where the `cd` always runs and its directory is there now; failing
 * that, only what a `&&` chains off it is sure of it (#4009). A `&` closing that
 * chain backgrounds the `cd` with it.
 * @param {Walk} walk accumulator: its cwd and doubts are moved
 * @param {string[]} own
 * @param {number} segIdx
 * @param {(path: string) => boolean} isDir
 */
function stepCwd(walk, own, segIdx, isDir) {
	const { cwd, cwdNames, cwdLost } = walk;
	if (!moveCwd(walk, own)) return false;
	const before = walk.parsed.joins[segIdx];
	const after = walk.parsed.joins[segIdx + 1];
	if (before === "p" || after === "p" || after === "b") {
		Object.assign(walk, { cwd, cwdNames, cwdLost });
		return true;
	}
	if (walk.cwd === cwd) return true;
	const { joins, segments } = walk.parsed;
	let end = segIdx + 1;
	while (joins[end] === "a") end++;
	const sure =
		joins[end] !== "b" &&
		own.length <= 2 &&
		!segments.some((s) => COMPOUND_START.test(s)) &&
		before !== "a" &&
		before !== "o" &&
		walk.cwd !== "" &&
		isDir(walk.cwd);
	if (sure) return true;
	if (after === "a") walk.cwdPending = [...walk.cwdPending, cwd];
	else walk.cwdDoubt = [...walk.cwdDoubt, cwd];
	return true;
}

const CONFIG_READ = /^(?:--get|--list$|-l$)/;

/**
 * Note a `git config` naming an alias or an include, or a key it cannot read:
 * what it writes is not on disk when the hook reads it.
 * @param {Walk} walk accumulator
 * @param {string[]} args raw
 */
function markAliasWritten(walk, args) {
	const read = args.map((w) => literal(w, walk.scope.spans));
	if (read.some((l) => CONFIG_READ.test(l.text))) return;
	walk.aliasWritten ||= read.some((l, i) =>
		/* A last word after another is a value, whatever it holds. */
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

/**
 * Mark the repository variables unread where a command mentions them other than
 * as a `git` prefix or a plain `export`: an assignment after an export, `set -a`,
 * `eval` and `local -x` each change the environment in a way not followed here.
 * @param {Walk} walk accumulator: its `gitEnv` is replaced
 * @param {string[]} words
 * @param {boolean} assigning the segment holds assignments alone
 */
function markRepoVarsUnread(walk, words, assigning) {
	const text = words.map((w) => literal(w, walk.scope.spans).text).join(" ");
	/* A bare `HOME=` moves a variable already exported (measured). Any other
	 * command naming `HOME` or `XDG_CONFIG_HOME` only reads it, far too often to
	 * call each one a move. */
	const candidates = [
		...REPO_VARS,
		...CONFIG_FILE_VARS.filter((name) => assigning || name.startsWith("GIT_")),
	];
	const named = candidates.filter((name) =>
		new RegExp(`\\b${name}\\b`).test(text),
	);
	if (named.length === 0) return;
	walk.gitEnv = new Map(walk.gitEnv);
	for (const name of named) walk.gitEnv.set(name, null);
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

/**
 * Move `walk.gitEnv` for one `export`, `declare -x`, `typeset -x` or `unset`;
 * whether the command is one of them. A bare assignment exports nothing
 * (measured), so a name only `export` names reads its value through the shell.
 * @param {Walk} walk accumulator: its `gitEnv` is replaced
 * @param {string[]} words
 */
function trackExport(walk, [head = "", ...rest]) {
	const kind = exportKind(head, rest);
	if (kind === null) return false;
	const env = new Map(walk.gitEnv);
	for (const w of rest) {
		const text = literal(w, walk.scope.spans).text;
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
 * @param {{ scope: Scope, dirs: { gitDir?: string | null,
 *   workTree?: string | null } }} from `dirs`, an accumulator, holds the
 *   directories read after the `-C`s end
 */
function stepGitOption(w, next, target, { scope, dirs }) {
	const { spans } = scope;
	if (w === "--git-dir") dirs.gitDir = next;
	else if (w.startsWith("--git-dir="))
		dirs.gitDir = w.slice("--git-dir=".length);
	else if (w === "--work-tree") dirs.workTree = next;
	else if (w.startsWith("--work-tree="))
		dirs.workTree = w.slice("--work-tree=".length);
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
 * Step git's own options; the index of the subcommand, or past the end where
 * there is none. The directories `--git-dir`, `--work-tree` or the environment
 * name are read last, since git reads a relative one from wherever the `-C`s
 * end. A quoted option is an option, and a word it cannot read ends the options.
 * @param {string[]} own the command's words, `git` first
 * @param {GitTarget} target
 * @param {{ scope: Scope, env: GitEnv, isDir: (path: string) => boolean }} from
 */
function readGitOptions(own, target, { scope, env, isDir }) {
	let i = 1;
	/** @type {{ gitDir?: string | null, workTree?: string | null }} */
	const dirs = {
		gitDir: env.get("GIT_DIR"),
		workTree: env.get("GIT_WORK_TREE"),
	};
	/** @param {string | undefined} raw @returns {string | null} */
	const optionAt = (raw) => {
		if (raw === undefined) return null;
		const { known, text } = literal(raw, scope.spans);
		if (known) return text.startsWith("-") ? text : null;
		return raw.startsWith("-") ? raw : null;
	};
	for (let w = optionAt(own[1]); w !== null; w = optionAt(own[i])) {
		stepGitOption(w, own[i + 1] ?? "", target, { scope, dirs });
		i += isGitValueOption(w) ? 2 : 1;
	}
	nameRepoTree(dirs.gitDir, env.get("GIT_COMMON_DIR"), target, {
		scope,
		isDir,
	});
	nameWorkTree(dirs.workTree, target, scope);
	return i;
}

/**
 * A directory word as an absolute path from `target`'s tree; "" where it will not
 * resolve.
 * @param {string} word
 * @param {GitTarget} target
 * @param {Scope} scope
 */
function absFromTree(word, target, scope) {
	const r = pathArg(word, scope);
	const path = r && "path" in r ? r.path : "";
	const abs =
		path.startsWith("/") || !path || !target.tree
			? path
			: `${target.tree}/${path}`;
	return abs.startsWith("/") ? abs : "";
}

/**
 * @param {string | null | undefined} word
 * @param {GitTarget} target accumulator: its `workTree` and `written` are set
 * @param {Scope} scope
 */
function nameWorkTree(word, target, scope) {
	if (word === undefined) return;
	const abs = word === null ? "" : absFromTree(word, target, scope);
	target.workTree = abs && normAbs(abs);
	if (!abs) target.written = `--work-tree ${word}`;
}

/**
 * Set `target.named` to the tree the git directory names. Unknown where both are
 * named, as the refs and the HEAD can live apart; where it is empty, which git
 * refuses (measured); and where it is a file not called `.git`, a gitfile that
 * could point anywhere.
 * @param {string | null | undefined} gitDir
 * @param {string | null | undefined} commonDir
 * @param {GitTarget} target accumulator: its `named` and `written` are set
 * @param {{ scope: Scope, isDir: (path: string) => boolean }} from
 */
function nameRepoTree(gitDir, commonDir, target, { scope, isDir }) {
	const word = gitDir === undefined ? commonDir : gitDir;
	if (word === undefined) return;
	const both = gitDir !== undefined && commonDir !== undefined;
	const abs = both || word === null ? "" : absFromTree(word, target, scope);
	const tree = abs ? treeOfGitDir(abs) : "";
	const readable = tree !== "" && (tree !== normAbs(abs) || isDir(abs));
	target.named = readable ? tree : "";
	if (!readable) target.written = `--git-dir ${word}`;
}

/**
 * The tree a git directory belongs to, read as a path: a tree's `.git` is its
 * root, where a linked tree's is the file the classifier would not enter. Any
 * other directory stands for itself, as the classifier asks git about it.
 * @param {string} dir absolute
 */
const treeOfGitDir = (dir) => normAbs(dir).replace(/\/\.git$/, "") || "/";

/**
 * Move `target` for one `git -C <word>`. `git -C ""` runs against the cwd —
 * git treats an empty path as if -C were not given (#301) — so the tree
 * stands where it is. A relative path from an unknown tree stays unknown.
 * @param {string} word
 * @param {GitTarget} target
 * @param {Scope} scope
 */
function readGitDir(word, target, scope) {
	const r = pathArg(word, scope);
	if (r && "empty" in r) {
		target.names = [...target.names, ...scope.emptyNames];
		return;
	}
	if (!r) {
		target.tree = "";
		target.written = `-C ${word}`;
	} else if (r.path.startsWith("/")) {
		target.tree = r.path;
		target.fromCwd = null;
		target.names = [...scope.emptyNames];
		target.written = "";
	} else if (target.tree) {
		target.tree = `${target.tree}/${r.path}`;
		if (target.fromCwd !== null) target.fromCwd += `/${r.path}`;
		target.names = [...target.names, ...scope.emptyNames];
	}
}

/**
 * The unresolved-tree record's detail (#315, #320): what the walk could not
 * resolve as typed, the hook's own directory, and the walk's cwd.
 * @param {GitTarget} git
 * @param {Walk} walk
 * @param {string} pwd
 */
function unresolvedDetail(git, walk, pwd) {
	const t = git.written || git.tree || walk.cwdLost;
	const typed = asWritten(t || "<unknown>", walk.scope.spans);
	return `target=${typed} pwd=${pwd} cwd=${walk.cwd || "<unknown>"}`;
}

/**
 * The line #310 ruled for a refusal whose tree was reached through an unset
 * variable, with a blank line after it; "" where `emptyVars` names none.
 * @param {string[]} emptyVars a GitCall's
 */
function unsetText(emptyVars) {
	const names = [...new Set(emptyVars)];
	if (names.length === 0) return "";
	const list = names.map((n) => `\`$${n}\``).join(", ");
	const verb = names.length === 1 ? "is" : "are";
	return `${list} ${verb} unset in this call; shell variables do not carry over between Bash calls.\n\n`;
}

/**
 * @param {RedirectEntry[]} redirs stripRedirects's entries
 * @param {Scope} scope
 * @param {(word: string) => string} resolveAbs
 * @returns {Redirect[]}
 */
function readRedirects(redirs, scope, resolveAbs) {
	return redirs.map((entry) => readRedirect(entry, scope, resolveAbs));
}

/**
 * One stripRedirects entry as a Redirect.
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

/** The kind each operator but `>&` and `<&` names. */
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
 * A `>&` or `<&`'s kind, and its descriptor as `fd` was written. Bash decides
 * on the expanded word, so `>&$fd` is read through its value, and taken as a
 * copy where it has none.
 * @param {string} op
 * @param {string} fd
 * @param {string} target
 * @param {Scope} scope
 */
function readDescriptorCopy(op, fd, target, scope) {
	const word = resolveWord(target, scope) ?? "1";
	if (word === "-") return { kind: "close", fd };
	if (/^[0-9]+-?$/.test(word)) return { kind: "copy", fd };
	/* `>&file` with no descriptor is bash's older `&>file`. */
	if (op === ">&" && !fd) return { kind: "truncate", fd: "&" };
	return { kind: "read", fd };
}

/**
 * An assignment's value as this file resolves it — "" for an empty one or a
 * quoted `""` — or null where it will not resolve.
 * @param {string} raw
 * @param {Scope} scope
 */
function assignedValue(raw, scope) {
	if (!raw) return "";
	const r = pathArg(raw, scope);
	if (!r) return null;
	return "path" in r ? r.path : "";
}

/**
 * Record `name`'s assignment of `val`, or put it in `dead` where `val` is
 * unresolved (null) or differs from a value it already holds.
 * @param {Scope} scope
 * @param {string} name
 * @param {string | null} val
 */
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
 * Every file one command writes or removes (#1827), by the routes the guard
 * tier reads:
 *
 *   a redirect            every kind isWriteRedirect names; a heredoc's own
 *                         redirect is read, its body is data
 *   `cp` / `mv`           the LAST bare word, or `-t <dir>`, as
 *                         `<dest>/<basename>` where the destination is a
 *                         directory, ends in `/` or takes two sources — and for
 *                         `mv` alone its SOURCES, which it destroys
 *   `sed -i` / `perl -i`  every bare file argument
 *   `truncate`, `tee`     every bare file argument
 *   `git restore <path>`  every bare word after the subcommand, unless
 *                         `--staged` without `--worktree`
 *   `git checkout -- <p>` every bare word after the `--`
 *   `rm`, `git rm`,       every bare word, and every word past a `--`
 *   `git mv`
 *
 * The command word is read as written, never unwrapped, so `sudo tee x` is not
 * read. `git checkout <path>` without `--` is not read: the word is a revision
 * as often as a path. Nor is a git global option.
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
 * Each command writeTargets reads, by its name as written, and how.
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

/**
 * `git restore`, `git checkout --`, `git mv` and `git rm`'s targets.
 * @param {string[]} args
 * @param {AddTarget} add
 */
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

/**
 * Every bare word as a write target; `skip` names the flags whose VALUE is
 * the next word.
 * @param {string[]} skip
 * @param {string[]} ws
 * @param {AddTarget} add
 */
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

/** No flag of `rm`, `git rm` or `git mv` takes a separate value but
 * `git rm --pathspec-from-file`, whose file then lands here.
 * @param {string[]} ws
 * @param {AddTarget} add */
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

/**
 * Is any word an in-place switch? Bundled single letters are read left to
 * right and the scan stops at the first switch that TAKES an argument, so
 * `perl -Ilib` is not misread as in-place on its `i`.
 * @param {string} takesArg
 * @param {string[]} words
 */
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

/**
 * Does a bundle of single-letter switches hold `i` before any switch that
 * takes an argument?
 * @param {string} w
 * @param {string} takesArg
 */
function hasInPlaceLetter(w, takesArg) {
	for (const ch of w.slice(1)) {
		if (ch === "i") return true;
		if (takesArg.includes(ch)) return false;
	}
	return false;
}

/**
 * `cp` and `mv`'s destinations, and `mv`'s sources. `cp` leaves its sources
 * alone, so reading them would report a read as a write.
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
	/* A directory as this hook sees it, or one by its own spelling — a
	 * trailing `/` names nothing else, existing or not. */
	const into = isDirectoryDest(dpath, lit, ctx) || dest.into;
	const dir = { base: dest.text.replace(/\/$/, ""), dpath };
	for (const src of srcs) {
		if (into) addIntoTarget(src, dir, add, ctx);
		if (prog === "mv") add("move-source", src);
	}
	if (!into) add("write", dest.text, dpath);
}

/** Flags of `cp` and `mv` whose value is the next word: 1, the target
 * directory; 2, a backup suffix, a value and no file. */
const COPY_VALUE_FLAGS = new Map([
	["-t", 1],
	["--target-directory", 1],
	["-S", 2],
	["--suffix", 2],
]);

/**
 * `cp` or `mv`'s bare words, and the `-t` directory where one is named.
 * @param {string[]} args
 */
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

/**
 * The destination — the `-t` directory, else the last bare word, taken off
 * the sources — and whether it must be a directory; null where there is none.
 * @param {{ dest: string, srcs: string[] }} parsed
 */
function pickDestination({ dest, srcs }) {
	if (dest) return { srcs, dest: { text: dest, into: true } };
	if (srcs.length < 2) return null;
	const last = srcs.pop();
	if (last === undefined) return null;
	/* Two sources or more land in a directory or nowhere. */
	return { srcs, dest: { text: last, into: srcs.length >= 2 } };
}

/**
 * Is the destination a directory as this hook sees it, or by its spelling?
 * @param {string} dpath
 * @param {string} lit
 * @param {TargetCtx} ctx
 */
const isDirectoryDest = (dpath, lit, ctx) =>
	Boolean(dpath && ctx.isDir(dpath)) || lit.endsWith("/");

/**
 * One source copied into the destination directory, as `<dest>/<basename>`.
 * @param {string} src
 * @param {{ base: string, dpath: string }} dir the destination as written, no
 *   trailing `/`, and absolute, or ""
 * @param {AddTarget} add
 * @param {TargetCtx} ctx
 */
function addIntoTarget(src, { base, dpath }, add, ctx) {
	/* The basename as written where it reads, else the masked word's own —
	 * `"$F"` stays unreadable to the caller, `$HOME/a.md` comes back
	 * `a.md`. */
	const name = literal(src, ctx.spans);
	const tgt = `${base}/${basename(name.known ? name.text : src)}`;
	const rsrc = ctx.resolve(src) ?? name.text;
	add("write", tgt, dpath && rsrc ? normAbs(`${dpath}/${basename(rsrc)}`) : "");
}

module.exports = {
	parseCommand,
	walkCommands,
	TEXT_ONLY_PORTS,
	unmask,
	asWritten,
	normAbs,
	walkGit,
	unsetText,
	BASH_SPACE: SPACE,
};
