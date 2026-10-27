/*
 * wait-loop.js — the dispatcher core that judges a hand-rolled wait in a Bash
 * call (mantahostels#2042, spec mantahostels#2017, from the snapshot at
 * mantahostels#2012): a loop around `sleep` with no ceiling is warned, and a
 * wait over 15 minutes is refused (#1288).
 *
 * Why: an `until`/`while` loop around `sleep` inside one Bash call is one tool
 * call, so nothing else here sees it. When its condition can never become true
 * the shell loops for ever, outlives the session that made it, reparents to
 * init, and keeps running after the founder has been told the session is
 * Completed.
 *
 * THE UNBOUNDED LOOP ONLY WARNS (mantahostels#103, mantahostels#2017 §Out of
 * Scope): an unbounded wait is sometimes the right call and only the caller
 * knows.
 *
 * A WAIT OVER 15 MINUTES IS DENIED (#1288, ruled at #1286). Three shapes are a
 * wait, foreground or backgrounded alike:
 *  - the command's literal `sleep`s, summed past 900 s (GNU sums `sleep 1h
 *    30m` too; `infinity` counts);
 *  - a counted loop — a `for` over `seq` or `{a..b}`, or a cap with a counter —
 *    whose count × summed literal sleeps passes it;
 *  - `timeout` past 900 s around a wait whose own length is unread: a `sleep`
 *    with no literal duration, or a `while`/`until` with no count, reached
 *    through `bash -c` and any leading assignments.
 * Long WORK is not a wait: `timeout 3600 npm run build` passes, and so do
 * watch-artefact.js and session-arbiter.js wait, neither being a sleep. The
 * deny still fires where docs/agents/rules/wait-length.txt will not read, its
 * fallback naming the file.
 *
 * LIMITS
 *  - It is a RAW REGEX over the command text, not a walk over parsed commands,
 *    there being no `-f`-shaped flag to key off. Both verdicts read it with
 *    every quoted span and heredoc body emptied but a shell's own script (see
 *    THE DENY below), so a commit message or issue body mentioning `while`
 *    passes and `bash -c 'until …'` is still read.
 *  - A `for` loop never warns, being bounded by construction; the deny counts
 *    one only where `seq` or `{a..b}` states its count.
 *  - A loop's extent is read as the text from its keyword to the `done` that
 *    closes a command, lexically. A nested loop ends the outer one early, so an
 *    outer loop whose only `sleep` sits after the inner `done` is judged as
 *    having none. A loop that never closes — `until …; do sleep 5` with the
 *    `done` in a later tool call — runs to the end of the command text.
 *  - `timeout` anywhere in the command clears every loop in it of the
 *    warning — a `timeout` wrapping some other command, one inside a comment.
 *    Deliberately loose; one inside a quoted span or heredoc body does not.
 *  - THE DENY reads the command with every quoted span and heredoc body
 *    emptied but a shell's own script (`bash -c '…'`, `bash <<EOF`), so a
 *    commit message or a written file quoting a long sleep passes. A comment
 *    and an `eval` string are still read; `grep -c "…"` is read
 *    as a `-c` script. It is blind to `sleep "$n"` or `sleep $((60*60))`. A
 *    `timeout`'s wrapped command is judged by its first word, so `timeout 3600
 *    bash -c 'until npm test; do sleep 5; done'`, a retry loop, is refused as a
 *    wait. A counted loop past the cap is refused even inside a shorter
 *    `timeout`, and a backgrounded `sleep 600 & sleep 600` reads as 20 minutes.
 *  - A `break` is not read as a ceiling, so `while :; do check && break;
 *    sleep 5; done` warns.
 *  - A ceiling is recognised lexically, and in TWO PARTS TOGETHER: a numeric
 *    comparison in the condition (`-ge 36`, `< 36`) AND an increment idiom in
 *    the body (`((n++))`, `n=$((n+1))`, `((n+=1))`). A comparison alone is
 *    usually a data condition — `until [ "$(free -m …)" -ge 1850 ]` waits on
 *    the machine and not on a count — and still warns. So does a ceiling
 *    spelled any other way: a deadline against `date +%s`, a bound held in a
 *    variable, a counter with no numeric literal.
 *  - First fire wins: a compound command carrying four unbounded loops has one
 *    thing wrong with it and is told once.
 *  - Its classes are ASCII: a letter or space outside ASCII never opens a
 *    word, a keyword or a delimiter.
 *  - It guards the Bash tool. A loop started from the founder's own terminal
 *    sees no hook; scripts/check-orphan-wait-loops.js is that backstop.
 */

/** `[[:space:]]`, without JavaScript's wider Unicode `\s`. */
const SP = " \\t\\n\\v\\f\\r";

/* A word in command position: at the start, or after a separator, a shell
 * keyword's trailing space, or a newline. Both quote characters are in the
 * class, so `bash -c 'until …'` is seen. */
const SEP = `(^|['";&|(!{${SP}])`;

const LOOP_RE = new RegExp(`${SEP}(while|until|for)[${SP}]`);
/* The loop's end: `done` closing a command, never `done` as an argument to
 * one. It carries its own trailing delimiter, which is what the truncation
 * cuts on; a quote is one, closing a `bash -c '…; done'` script (#1808). */
const DONE_RE = new RegExp(`[;&|)}\\n][${SP}]*done[;&|)}${SP}'"]`);
const SLEEP_RE = new RegExp(`${SEP}sleep[${SP}]`);
const SLEEP_RUN_RE = new RegExp(`${SEP}sleep[${SP}][${SP}]*`);
/* `((n++))`, `((n += 1))` and `n=$((n+1))` — the increment idioms
 * mantahostels#2017 names. */
const BUMP_RE = new RegExp(
	`\\(\\([${SP}]*[A-Za-z0-9_]+[${SP}]*(\\+\\+|\\+=)|=\\$\\(\\([${SP}]*[A-Za-z0-9_]+[${SP}]*\\+`,
);
/* An explicit iteration cap: `[ $n -ge 36 ]`, `(( n < 36 ))`. */
const CAP_RE = new RegExp(
	`(-(ge|gt|le|lt)[${SP}]+[0-9]+|[<>]=?[${SP}]*[0-9]+)`,
);
/* Where the condition ends, so the cap is read from the condition, not the
 * body. */
const DO_RE = new RegExp(`[;&|)}\\n][${SP}]*do[${SP}]`);
const TIMEOUT_RE = new RegExp(`${SEP}timeout[${SP}]`);
const TIMEOUT_RUN_RE = new RegExp(`${SEP}timeout[${SP}]+`);

const BRACE_RE = /\{([0-9]{1,9})\.\.([0-9]{1,9})\}/;
const SEQ_RE = new RegExp(
	`seq[${SP}]+([0-9]{1,9})([${SP}]+([0-9]{1,9}))?([${SP}]+([0-9]{1,9}))?`,
);

const WAIT_CAP_MS = 900_000;
/** What `sleep infinity`, or a duration too long to count, reads as. */
const ENDLESS_MS = 999_999_999_999_999;
/* A duration word ends at whitespace, a separator or a quote, so the `9984`
 * in `bash -c "sleep 9984"` is read without its closing quote. */
const WORD_RE = new RegExp(`^([^${SP};&|)'"]+)[${SP}]*`);
const DURATION_RE = /^([0-9]*)(\.([0-9]*))?([smhd]?)$/;

const QUOTE_RE = /^([^'"]*)(['"])/;
const DQUOTED_RE = /^((?:[^"\\]|\\[\s\S])*)"/;
const SHELL_C_RE = new RegExp(`(^|[${SP}])-[A-Za-z]*c[${SP}]+$`);
const HEREDOC_RE = new RegExp(
	`(^|[^<])<<-?[${SP}]*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?`,
);
const SHELL_FED_RE = new RegExp(
	`(^|[;&|({${SP}])(/[^${SP}]*/)?(ba|da|z)?sh([${SP}]+-[A-Za-z]+)*[${SP}]*$`,
);

/* The `timeout` shape: its own flags, `-s KILL` and `-k 5` taking a value;
 * then `bash -c`, any flags of the shell's, an opening quote and leading
 * `n=0;` assignments, to reach the wrapped command's first word. */
const TIMEOUT_VALUED_RE = new RegExp(
	`^(-[sk]|--signal|--kill-after)[${SP}]+[^${SP}]+[${SP}]+`,
);
const TIMEOUT_FLAG_RE = new RegExp(`^-[^${SP}]*[${SP}]+`);
const SHELL_RE = new RegExp(
	`^(/[^${SP}]*/)?(ba|da|z)?sh([${SP}]+-[A-Za-z]+)*[${SP}]+['"]?`,
);
const ASSIGN_RE = new RegExp(
	`^[A-Za-z_][A-Za-z0-9_]*=[^${SP};&]*[${SP}]*(;|&&)?[${SP}]*`,
);
const WRAPPED_SLEEP_RE = new RegExp(`^sleep[${SP}]+([^${SP}]*)`);
const WRAPPED_LOOP_RE = new RegExp(`^(while|until)[${SP}]`);

const RULE_FALLBACK = `A Bash wait of more than ${WAIT_CAP_MS / 60_000} minutes is banned; the rule could not be read from docs/agents/rules/wait-length.txt. Read that file before doing anything else: it says how to hand the work back instead.`;

/**
 * @typedef {{ kw: string, body: string, condition: string }} Loop
 */

/**
 * `text` cut at the first place `piece` stands, as bash's `${text%%"$piece"*}`.
 * @param {string} text
 * @param {string} piece
 */
const before = (text, piece) => {
	const at = text.indexOf(piece);
	return at < 0 ? text : text.slice(0, at);
};

/**
 * `text` after the first place `piece` stands, as bash's `${text#*"$piece"}`.
 * @param {string} text
 * @param {string} piece
 */
const after = (text, piece) => {
	const at = text.indexOf(piece);
	return at < 0 ? text : text.slice(at + piece.length);
};

/**
 * Each `while`/`until`/`for` loop in `text` that holds a `sleep`, in order.
 * @param {string} text
 * @returns {Generator<Loop>}
 */
function* loops(text) {
	let rest = text;
	for (;;) {
		const m = LOOP_RE.exec(rest);
		if (!m) return;
		const lead = m[0];
		rest = after(rest, lead);
		/* The trailing newline gives DONE_RE its delimiter on a loop ending the
		 * command. See LIMITS for what a nested loop does to that boundary. */
		let body = `${lead}${rest}\n`;
		const done = DONE_RE.exec(body);
		if (done) body = before(body, done[0]);
		/* No sleep in it, so it is not a wait loop — its exit is not governed
		 * by an external condition and nothing here applies (mantahostels#2017,
		 * user story 6). */
		if (!SLEEP_RE.test(body)) continue;
		const doAt = DO_RE.exec(body);
		yield {
			kw: m[2] ?? "",
			body,
			condition: doAt ? before(body, doAt[0]) : body,
		};
	}
}

/**
 * The loop's iteration count, where its text states one: a `for` over `seq`
 * or `{a..b}`, or a cap in the condition with a counter in the body moving
 * toward it. Null where it states none.
 * @param {Loop} loop
 * @returns {number | null}
 */
function count({ kw, body, condition }) {
	if (kw === "for") return forCount(condition);
	const cap = CAP_RE.exec(condition);
	if (!cap || !BUMP_RE.test(body)) return null;
	const digits = /[0-9]*$/.exec(cap[0])?.[0] ?? "";
	return digits.length < 10 ? Number(digits) : 999_999_999;
}

/**
 * A `for` loop's count, from `{a..b}` or `seq`'s one, two or three numbers.
 * @param {string} condition
 * @returns {number | null}
 */
function forCount(condition) {
	const brace = BRACE_RE.exec(condition);
	if (brace) {
		const a = Number(brace[1]);
		const b = Number(brace[2]);
		return a > b ? a - b + 1 : b - a + 1;
	}
	const seq = SEQ_RE.exec(condition);
	if (!seq) return null;
	const a = Number(seq[1]);
	if (seq[3] === undefined) return a;
	if (seq[5] === undefined) return Number(seq[3]) - a + 1;
	const step = Number(seq[3]);
	return step > 0 ? Math.trunc((Number(seq[5]) - a) / step) + 1 : null;
}

/**
 * GNU sleep/timeout's duration grammar (a decimal, then an optional s/m/h/d)
 * in milliseconds; null on anything else.
 * @param {string} word
 * @returns {number | null}
 */
function durationMs(word) {
	if (/^inf(inity)?$/.test(word)) return ENDLESS_MS;
	const m = DURATION_RE.exec(word);
	if (!m) return null;
	const int = m[1] ?? "";
	const fracDigits = m[3] ?? "";
	if (`${int}${fracDigits}` === "") return null;
	if (int.length > 11) return ENDLESS_MS;
	const mult = { m: 60, h: 3600, d: 86_400 }[m[4] ?? ""] ?? 1;
	const frac = Number(`${fracDigits}000`.slice(0, 3));
	return (Number(int || "0") * 1000 + frac) * mult;
}

/**
 * Every `sleep` in `text`: their literal lengths summed, their spellings, and
 * how many had no literal duration to read.
 * @param {string} text
 */
function sleeps(text) {
	let rest = text;
	let sum = 0;
	let spelled = "";
	let unread = 0;
	for (;;) {
		const m = SLEEP_RUN_RE.exec(rest);
		if (!m) break;
		rest = after(rest, m[0]);
		const { n, total, words } = durations(rest);
		if (n === 0) {
			unread++;
			continue;
		}
		sum += total;
		spelled += `${spelled ? "; " : ""}sleep${words}`;
	}
	return { sum, spelled, unread };
}

/**
 * The run of duration words `text` opens with: how many, their milliseconds
 * summed, and their spellings, each after a space.
 * @param {string} text
 */
function durations(text) {
	let t = text;
	let n = 0;
	let total = 0;
	let words = "";
	for (;;) {
		const w = WORD_RE.exec(t);
		const ms = w ? durationMs(w[1] ?? "") : null;
		if (!w || ms === null) return { n, total, words };
		t = t.slice(w[0].length);
		words += ` ${w[1]}`;
		total += ms;
		n++;
	}
}

/**
 * `text` with every quoted span emptied but a shell's `-c` script, which is
 * kept with its own quoted spans emptied in turn. An unclosed quote empties
 * the rest.
 * @param {string} text
 * @returns {string}
 */
function mask(text) {
	let s = text;
	let out = "";
	for (;;) {
		const m = QUOTE_RE.exec(s);
		if (!m) break;
		out += m[1];
		const q = m[2];
		s = s.slice(m[0].length);
		let span;
		if (q === "'") {
			if (!s.includes("'")) {
				s = "";
				break;
			}
			span = before(s, "'");
			s = after(s, "'");
		} else {
			const d = DQUOTED_RE.exec(s);
			if (!d) {
				s = "";
				break;
			}
			span = d[1] ?? "";
			s = s.slice(d[0].length);
		}
		out += SHELL_C_RE.test(out) ? `${q}${mask(span)}${q}` : `${q}${q}`;
	}
	return out + s;
}

/**
 * `text` with every heredoc body emptied but one fed to a shell (`bash
 * <<EOF`), so a script written with `cat > f <<EOF` or piped to `python3 -
 * <<EOF` is not read as the call's own wait.
 * @param {string} text
 * @returns {string}
 */
function unheredoc(text) {
	let s = text;
	let out = "";
	for (;;) {
		const m = HEREDOC_RE.exec(s);
		if (!m) break;
		const op = m[0];
		out += before(s, op);
		const keep = SHELL_FED_RE.test(`${out}${m[1]}`);
		s = after(s, op);
		out += op;
		/* The rest of the operator's line is still command; the body starts
		 * below it. */
		if (!s.includes("\n")) break;
		out += `${before(s, "\n")}\n`;
		const body = heredocBody(after(s, "\n"), m[2] ?? "", keep);
		out += body.out;
		s = body.rest;
	}
	return out + s;
}

/**
 * A heredoc body read off the front of `text` up to its `delim` line: the body
 * as written where `keep`, else only the delimiter line, and the text after.
 * @param {string} text
 * @param {string} delim
 * @param {boolean} keep
 */
function heredocBody(text, delim, keep) {
	let s = text;
	let out = "";
	while (s !== "") {
		const line = before(s, "\n");
		s = s.includes("\n") ? after(s, "\n") : "";
		if (line.replace(/^\t*/, "") === delim)
			return { out: `${out}${line}\n`, rest: s };
		if (keep) out += `${line}\n`;
	}
	return { out, rest: s };
}

/**
 * A loop as the session wrote it: from its first `w`, `u` (or `f`, in `from`)
 * on, one trailing newline off.
 * @param {string} body
 * @param {RegExp} from
 */
const named = (body, from) => {
	const at = body.search(from);
	return (at < 0 ? "" : body.slice(at)).replace(/\n$/, "");
};

/**
 * The refusal of a wait `what` long `ms`.
 * @param {string} what
 * @param {number} ms
 * @param {import("./guard-dispatch.js").CoreContext} ctx
 */
function waitDeny(what, ms, ctx) {
	const length =
		ms >= ENDLESS_MS
			? "without end"
			: `${Math.floor((ms + 59_999) / 60_000)} minutes`;
	let rule;
	try {
		rule = ctx.ruleText("wait-length");
	} catch {
		/* Not a fail-open: the wait is read and known too long, and an
		 * unreadable fragment is check-guard-registry.js's assertion. */
		rule = RULE_FALLBACK;
	}
	return {
		deny: ctx.corePaths(
			`This waits ${length} — ${what} — and the limit is 15 minutes.\n\n${rule}`,
		),
	};
}

/**
 * The deny's three shapes, in order: the summed sleeps, a counted loop, a
 * long `timeout` around an unread wait.
 * @param {string} waits
 * @param {import("./guard-dispatch.js").CoreContext} ctx
 */
function denial(waits, ctx) {
	const all = sleeps(waits);
	if (all.sum > WAIT_CAP_MS)
		return waitDeny(`\`${all.spelled}\``, all.sum, ctx);
	const counted = countedWait(waits);
	if (counted) return waitDeny(counted.what, counted.ms, ctx);
	let rest = waits;
	for (;;) {
		const m = TIMEOUT_RUN_RE.exec(rest);
		if (!m) return null;
		rest = after(rest, m[0]);
		const timed = timedWait(rest);
		if (timed) return waitDeny(timed.what, timed.ms, ctx);
	}
}

/**
 * A counted loop past the cap: its iteration count times every literal sleep
 * in its body. Unread where any sleep in it is not a literal. No overflow: the
 * body's sleeps are within the command's, already under the cap, and the
 * count is under 10^9.
 * @param {string} waits
 * @returns {{ what: string, ms: number } | null}
 */
function countedWait(waits) {
	for (const loop of loops(waits)) {
		const n = count(loop);
		if (n === null) continue;
		const own = sleeps(loop.body);
		if (own.unread === 0 && n * own.sum > WAIT_CAP_MS)
			return { what: `\`${named(loop.body, /[wuf]/)}\``, ms: n * own.sum };
	}
	return null;
}

/**
 * `text` with every leading `match` taken off, one after another.
 * @param {string} text
 * @param {(t: string) => RegExpExecArray | null} match
 */
function stripLeading(text, match) {
	let t = text;
	for (let m = match(t); m; m = match(t)) t = t.slice(m[0].length);
	return t;
}

/**
 * What follows one `timeout`: past the cap and around a wait whose own length
 * is unread, that wait named; else null.
 * @param {string} text
 * @returns {{ what: string, ms: number } | null}
 */
function timedWait(text) {
	let t = stripLeading(
		text,
		(x) => TIMEOUT_VALUED_RE.exec(x) ?? TIMEOUT_FLAG_RE.exec(x),
	);
	const word = WORD_RE.exec(t);
	if (!word) return null;
	t = t.slice(word[0].length);
	const duration = word[1] ?? "";
	const ms = durationMs(duration);
	if (ms === null || ms <= WAIT_CAP_MS) return null;
	const shell = SHELL_RE.exec(t);
	if (shell) t = t.slice(shell[0].length);
	t = stripLeading(t, (x) => ASSIGN_RE.exec(x));
	const slept = WRAPPED_SLEEP_RE.exec(t);
	if (slept) {
		/* A literal sleep was judged above, at its own length. */
		const w = WORD_RE.exec(slept[1] ?? "");
		if (w && durationMs(w[1] ?? "") !== null) return null;
		return {
			what: `\`timeout ${duration}\` around a \`sleep\` of no literal length`,
			ms,
		};
	}
	if (!WRAPPED_LOOP_RE.test(t)) return null;
	const first = loops(t).next();
	if (first.done || count(first.value) !== null) return null;
	return {
		what: `\`timeout ${duration}\` around an uncounted \`${first.value.kw}\` loop`,
		ms,
	};
}

/**
 * The warning: the first wait loop with no ceiling, unless the command carries
 * a `timeout` anywhere. Each loop is judged on its own text, so a bounded loop
 * and an unbounded one can share a command line and still be told apart.
 * Bounded means an iteration cap in the CONDITION and a counter in the body
 * that moves toward it; either alone is not a ceiling — LIMITS says why.
 * @param {string} waits
 * @returns {string | null}
 */
function warning(waits) {
	if (TIMEOUT_RE.test(waits)) return null;
	for (const loop of loops(waits)) {
		if (loop.kw === "for" || count(loop) !== null) continue;
		/* The loop is named back, so a compound command's first-fire-wins
		 * warning says which of its loops was matched. */
		return `This wait loop has no ceiling — \`${named(loop.body, /[wu]/)}\` — so if its condition never becomes true the shell runs for ever. It outlives the session that wrote it, reparents to init, and goes on holding a slot after the session reads as Completed — mantahostels#2012 found one still running 13 hours later, its session gone.

Bound it, either way:

  timeout 600 bash -c 'until <condition>; do sleep 10; done'

  n=0; until [ $n -ge 36 ] || <condition>; do sleep 20; n=$((n+1)); done

What this guard cannot see: it reads a ceiling as a \`timeout\`, or a numeric comparison in the condition with a counter in the body. One spelled any other way — a deadline against \`date +%s\`, a bound held in a variable — reads as no ceiling at all. If your loop is genuinely unbounded on purpose, run it: this warning never refuses (mantahostels#2042).`;
	}
	return null;
}

/**
 * @param {string} command
 * @param {import("./guard-dispatch.js").CoreContext} ctx
 * @returns {import("./guard-dispatch.js").CoreDecision}
 */
function decide(command, ctx) {
	const waits = mask(unheredoc(command));
	const deny = denial(waits, ctx);
	if (deny) return deny;
	const warn = warning(waits);
	return warn === null ? null : { context: ctx.corePaths(warn) };
}

module.exports = { field: "command", noun: "command", decide };
