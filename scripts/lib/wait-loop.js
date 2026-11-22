const { ruleOrFallback } = require("./guard-verdict.js");
const { requiredGroup } = require("./regex-group.js");
const { endRun } = require("./trim-run.js");

const SP = " \\t\\n\\v\\f\\r";

const SEP = `(^|['";&|(!{${SP}])`;

const END = `[;&|)}'"${SP}]`;

const LOOP_RE = new RegExp(`${SEP}(while|until|for)[${SP}]`);
const DONE_WORD_RE = new RegExp(`done${END}`, "g");
const SLEEP_RE = new RegExp(`${SEP}sleep[${SP}]`);
const SLEEP_RUN_RE = new RegExp(`${SEP}sleep[${SP}][${SP}]*`);
const BUMP_RE = new RegExp(
	`\\(\\([${SP}]*[A-Za-z0-9_]+[${SP}]*(\\+\\+|\\+=)|=\\$\\(\\([${SP}]*[A-Za-z0-9_]+[${SP}]*\\+`,
);
const CAP_RE = new RegExp(
	`(-(ge|gt|le|lt)[${SP}]+[0-9]+|[<>]=?[${SP}]*[0-9]+)`,
);
const DO_WORD_RE = new RegExp(`do[${SP}]`, "g");
const CLOSER_RE = /[;&|)}\n]/;
const BLANK_RE = new RegExp(`[${SP}]`);
const TIMEOUT_RE = new RegExp(`${SEP}timeout[${SP}]`);
const TIMEOUT_RUN_RE = new RegExp(`${SEP}timeout[${SP}]+`);

const BRACE_RE = /\{([0-9]{1,9})\.\.([0-9]{1,9})\}/;
const SEQ_RE = new RegExp(
	`seq[${SP}]+([0-9]{1,9})([${SP}]+([0-9]{1,9}))?([${SP}]+([0-9]{1,9}))?`,
);

const WAIT_CAP_MS = 900_000;
const ENDLESS_MS = 999_999_999_999_999;
const WORD_RE = new RegExp(`^([^${SP};&|)'"]+)[${SP}]*`);
const DURATION_RE = /^([0-9]*)(\.([0-9]*))?([smhd]?)$/;

const QUOTE_RE = /^([^'"]*)(['"])/;
const DQUOTED_RE = /^((?:[^"\\]|\\[\s\S])*)"/;
const C_FLAG = "-[A-Za-z]*c";
const SHELL_C_RE = new RegExp(`(^|[${SP}])${C_FLAG}[${SP}]+$`);
const SCRIPT_RE = new RegExp(
	`(^|[${SP}])(${C_FLAG}|(node|nodejs|perl|ruby)([${SP}]+-[A-Za-z-]+)*[${SP}]+(-[A-Za-z]*[ep]|--eval|--print))[${SP}]+$`,
);
const LOAD_RE = new RegExp(
	`/proc/loadavg|loadavg[${SP}]*\\(|${SEP}uptime(${END}|$)`,
);
const LEAVE_RE = new RegExp(`${SEP}(break|exit)(${END}|$)`, "g");
const STATEMENT_END_RE = /;|\n|(?<![&<>])&(?![&>])/;
const IF_RE = new RegExp(`${SEP}(if|elif)[${SP}]`, "g");
const THEN_RE = new RegExp(`${SEP}then${END}`);
const FI_RE = new RegExp(`${SEP}fi(${END}|$)`);
const ASSIGNED_RE = /(?:^|[^A-Za-z0-9_$])([A-Za-z_][A-Za-z0-9_]*)=/g;
const READ_RE = new RegExp(
	`${SEP}read(?:[${SP}]+-[A-Za-z]+(?:[${SP}]+[0-9]+)?)*((?:[${SP}]+[A-Za-z_][A-Za-z0-9_]*)+)`,
);
const PARAM_RE = /(?<!\\)(?:\\\\)*\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;
const ARITH_RE = /\(\(([^()]*)\)\)/g;
const NAME_RE = /[A-Za-z_][A-Za-z0-9_]*/g;
const SUB_OPEN_RE = /(?<!\\)(?:\\\\)*(\$\(|`)/;
const HEREDOC_RE = new RegExp(
	`(^|[^<])<<-?[${SP}]*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?`,
);
const SHELL_FED_RE = new RegExp(
	`(^|[;&|({${SP}])(/[^${SP}]*/)?(ba|da|z)?sh([${SP}]+-[A-Za-z]+)*[${SP}]*$`,
);

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

/**
 * @typedef {{ kw: string, body: string, condition: string, doBody: string }} Loop
 * @typedef {{ script: RegExp, subs: boolean }} Masking
 */

/** @param {string} text @param {string} piece */
const before = (text, piece) => {
	const at = text.indexOf(piece);
	return at < 0 ? text : text.slice(0, at);
};

/** @param {string} text @param {string} piece */
const after = (text, piece) => {
	const at = text.indexOf(piece);
	return at < 0 ? text : text.slice(at + piece.length);
};

/**
 * @param {string} text
 * @param {RegExp} word
 * @returns {number}
 */
function closerBefore(text, word) {
	for (const m of text.matchAll(word)) {
		let at = -1;
		for (let i = m.index - 1; i >= 0; i--) {
			const c = text.charAt(i);
			if (CLOSER_RE.test(c)) at = i;
			if (!BLANK_RE.test(c)) break;
		}
		if (at >= 0) return at;
	}
	return -1;
}

/** @param {string} text @returns {Generator<Loop>} */
function* loops(text) {
	let rest = text;
	for (;;) {
		const m = LOOP_RE.exec(rest);
		if (!m) return;
		const lead = m[0];
		rest = after(rest, lead);
		let body = `${lead}${rest}\n`;
		const doneAt = closerBefore(body, DONE_WORD_RE);
		if (doneAt >= 0) body = body.slice(0, doneAt);
		if (!SLEEP_RE.test(body)) continue;
		const doAt = closerBefore(body, DO_WORD_RE);
		const condition = doAt >= 0 ? body.slice(0, doAt) : body;
		yield {
			kw: m[2] ?? "",
			body,
			condition,
			doBody: body.slice(condition.length),
		};
	}
}

/** @param {Loop} loop @returns {number | null} */
function count({ kw, body, condition }) {
	if (kw === "for") return forCount(condition);
	const cap = CAP_RE.exec(condition);
	if (!cap || !BUMP_RE.test(body)) return null;
	const digits = endRun(cap[0], "0123456789");
	return digits.length < 10 ? Number(digits) : 999_999_999;
}

/** @param {string} condition @returns {number | null} */
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

/** @param {string} word @returns {number | null} */
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

/** @param {string} text */
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

/** @param {string} text */
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

/** @param {string} text @param {Masking} [how] @returns {string} */
function mask(text, how = { script: SHELL_C_RE, subs: false }) {
	let s = text;
	let out = "";
	for (;;) {
		const m = QUOTE_RE.exec(s);
		if (!m) break;
		out += m[1];
		const q = requiredGroup(m, 2, QUOTE_RE);
		const quoted = closeQuote(q, s.slice(m[0].length));
		if (!quoted) return out;
		s = quoted.rest;
		out += `${q}${keptOf(quoted.span, q, how.script.test(out), how)}${q}`;
	}
	return out + s;
}

/** @param {string} q @param {string} text */
function closeQuote(q, text) {
	if (q === "'")
		return text.includes("'")
			? { span: before(text, "'"), rest: after(text, "'") }
			: null;
	const d = DQUOTED_RE.exec(text);
	return d
		? { span: requiredGroup(d, 1, DQUOTED_RE), rest: text.slice(d[0].length) }
		: null;
}

/**
 * @param {string} span
 * @param {string} q
 * @param {boolean} isScript
 * @param {Masking} how
 */
function keptOf(span, q, isScript, how) {
	if (isScript)
		return mask(q === '"' ? span.replace(/\\(["\\$`])/g, "$1") : span, how);
	if (q === '"' && how.subs) return substitutions(span, how);
	return "";
}

/** @param {string} span @param {Masking} how */
function substitutions(span, how) {
	/** @type {string[]} */
	const found = [];
	let rest = span;
	for (;;) {
		const m = SUB_OPEN_RE.exec(rest);
		if (!m) break;
		const token = requiredGroup(m, 1, SUB_OPEN_RE);
		const at = m.index + m[0].length - token.length;
		const tick = token === "`";
		const open = rest.slice(at + (tick ? 1 : 2));
		const end = tick ? open.indexOf("`") : closingParen(open);
		if (end < 0) break;
		found.push(open.slice(0, end));
		rest = open.slice(end + 1);
	}
	const params = span.match(PARAM_RE) ?? [];
	return [...found.map((sub) => mask(sub, how)), ...params].join(" ");
}

/** @param {string} text */
function closingParen(text) {
	let depth = 1;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "(") depth++;
		if (text[i] === ")") depth--;
		if (depth === 0) return i;
	}
	return -1;
}

/** @param {string} text @returns {string} */
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
		if (!s.includes("\n")) break;
		out += `${before(s, "\n")}\n`;
		const body = heredocBody(after(s, "\n"), m[2] ?? "", keep);
		out += body.out;
		s = body.rest;
	}
	return out + s;
}

/** @param {string} text @param {string} delim @param {boolean} keep */
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

/** @param {string} body @param {RegExp} from */
const named = (body, from) => {
	const at = body.search(from);
	return (at < 0 ? "" : body.slice(at)).replace(/\n$/, "");
};

/**
 * @param {string} lead
 * @param {string} rule
 * @param {import("./core-contract.js").CoreContext} ctx
 */
function ruleDeny(lead, rule, ctx) {
	return { deny: ctx.corePaths(`${lead}\n\n${rule}`) };
}

/**
 * @param {string} what
 * @param {number} ms
 * @param {import("./core-contract.js").CoreContext} ctx
 */
function waitDeny(what, ms, ctx) {
	const length =
		ms >= ENDLESS_MS
			? "without end"
			: `${Math.floor((ms + 59_999) / 60_000)} minutes`;
	return ruleDeny(
		`This waits ${length} — ${what} — and the limit is 15 minutes.`,
		ruleOrFallback(
			ctx,
			"wait-length",
			"A Bash wait past the limit is banned, and the rule says how to hand the work back instead",
		),
		ctx,
	);
}

/**
 * @param {string} waits
 * @param {import("./core-contract.js").CoreContext} ctx
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

/** @param {string} waits @returns {{ what: string, ms: number } | null} */
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

/** @param {string} text @param {(t: string) => RegExpExecArray | null} match */
function stripLeading(text, match) {
	let t = text;
	for (let m = match(t); m; m = match(t)) t = t.slice(m[0].length);
	return t;
}

/** @param {string} text @returns {{ what: string, ms: number } | null} */
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

/** @param {string} waits @returns {string | null} */
function warning(waits) {
	if (TIMEOUT_RE.test(waits)) return null;
	for (const loop of loops(waits)) {
		if (loop.kw === "for" || count(loop) !== null) continue;
		return `This wait loop has no ceiling — \`${named(loop.body, /[wu]/)}\` — so if its condition never becomes true the shell runs for ever. It outlives the session that wrote it, reparents to init, and goes on holding a slot after the session reads as Completed (mantahostels#2012).

Bound it, either way:

  timeout 600 bash -c 'until <condition>; do sleep 10; done'

  n=0; until [ $n -ge 36 ] || <condition>; do sleep 20; n=$((n+1)); done

What this guard cannot see: it reads a ceiling as a \`timeout\`, or a numeric comparison in the condition with a counter in the body. One spelled any other way — a deadline against \`date +%s\`, a bound held in a variable — reads as no ceiling at all. If your loop is genuinely unbounded on purpose, run it: this warning never refuses (mantahostels#2042).`;
	}
	return null;
}

/** @param {string} text @param {number} at */
function statementAt(text, at) {
	const head = text.slice(0, at).split(STATEMENT_END_RE).pop() ?? "";
	const tail = text.slice(at).split(STATEMENT_END_RE)[0] ?? "";
	return `${head}${tail}`;
}

/** @param {string} text @param {number} at */
function ifConditionAt(text, at) {
	const head = text.slice(0, at);
	const opens = [...head.matchAll(IF_RE)];
	const open = opens.at(-1);
	if (!open) return "";
	const from = head.slice(open.index);
	const then = THEN_RE.exec(from);
	if (!then || FI_RE.test(from.slice(then.index + then[0].length))) return "";
	return from.slice(0, then.index);
}

/** @param {string} text */
function refs(text) {
	const names = [...text.matchAll(PARAM_RE)].map((m) =>
		requiredGroup(m, 1, PARAM_RE),
	);
	for (const m of text.matchAll(ARITH_RE))
		names.push(...(requiredGroup(m, 1, ARITH_RE).match(NAME_RE) ?? []));
	return names;
}

/** @param {string} doBody */
function loadVars(doBody) {
	/** @type {Set<string>} */
	const names = new Set();
	const statements = doBody.split(STATEMENT_END_RE);
	for (let size = -1; size !== names.size; ) {
		size = names.size;
		for (const statement of statements) {
			if (
				!LOAD_RE.test(statement) &&
				!refs(statement).some((name) => names.has(name))
			)
				continue;
			for (const name of assigned(statement)) names.add(name);
		}
	}
	return names;
}

/** @param {string} statement */
function assigned(statement) {
	const names = [...statement.matchAll(ASSIGNED_RE)].map((m) =>
		requiredGroup(m, 1, ASSIGNED_RE),
	);
	const read = READ_RE.exec(statement);
	names.push(...(read?.[2] ?? "").split(/[^A-Za-z0-9_]+/).filter(Boolean));
	return names;
}

/** @param {string} doBody */
function bodyGates(doBody) {
	const vars = loadVars(doBody);
	for (const leave of doBody.matchAll(LEAVE_RE)) {
		const at = leave.index + (leave[1] ?? "").length;
		const test = `${statementAt(doBody, at)} ${ifConditionAt(doBody, at)}`;
		if (LOAD_RE.test(test) || refs(test).some((name) => vars.has(name)))
			return true;
	}
	return false;
}

/**
 * @param {string} written
 * @param {import("./core-contract.js").CoreContext} ctx
 */
function loadDenial(written, ctx) {
	const text = mask(written, { script: SCRIPT_RE, subs: true });
	for (const loop of loops(text)) {
		if (!LOAD_RE.test(loop.condition) && !bodyGates(loop.doBody)) continue;
		return ruleDeny(
			`This wait loop gates on machine load — \`${named(loop.body, /[wuf]/)}\`.`,
			ruleOrFallback(
				ctx,
				"load-wait",
				"A Bash wait gated on machine load is banned, and the rule says where each kind of wait goes instead",
			),
			ctx,
		);
	}
	return null;
}

/**
 * @param {string} command
 * @param {import("./core-contract.js").CoreContext} ctx
 * @returns {import("./core-contract.js").CoreDecision}
 */
function decide(command, ctx) {
	const written = unheredoc(command);
	const load = loadDenial(written, ctx);
	if (load) return load;
	const waits = mask(written);
	const deny = denial(waits, ctx);
	if (deny) return deny;
	const warn = warning(waits);
	return warn === null ? null : { context: ctx.corePaths(warn) };
}

module.exports = { field: "command", noun: "command", decide };
