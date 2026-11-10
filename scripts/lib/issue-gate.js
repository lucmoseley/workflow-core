/*
 * issue-gate.js — the two body markers that hold an issue out of
 * `pick-next.js`'s shortlist, one function each, and the basis line beneath
 * them, which holds nothing but is owed at write time (#672):
 *
 *   **Gated until:** YYYY-MM-DD — <why>  (mantahostels#85, no working channel to
 *       an outside partner, the ticket the date marker was built for)
 *   **Gated on:** <condition> — check: <command> — abandon if: <clause>
 *       (mantahostels#1419, the ticket that added the second spelling because a guessed
 *       date lies about what a machinery ticket is really waiting for)
 *   **Gate basis:** <what sets the window>  (#577; the template is the
 *       `gate-basis-line` rule fragment)
 *
 * A MARKER IN THE BODY, NOT A LABEL.
 *
 * EVERY UNREADABLE CASE FAILS OPEN — it gates nothing and is reported.
 */

const { requiredGroup } = require("./regex-group.js");
const { docPath } = require("./script-path");
const { witaDay } = require("./wita");
const { caught } = require("./caught.js");

/*
 * CommonMark's un-indented-paragraph tolerance, shared by both markers.
 * Anchoring at all is what stops a 4-space-indented code block quoting a
 * marker as an example from gating itself — a *fenced* block is not indented,
 * so each reader below checks for one separately (mantahostels#1435, #612).
 */
const AT_LINE_HEAD = "^[ \\t]{0,3}";

/*
 * A marker's tail less the blanks around it: it opens and closes on a
 * character that is neither a blank nor a line break, so the line is read once
 * to its end and back to that last character. As a lazy group before a
 * trailing blank run, every character of a long blank stretch would retry the
 * run to the line's end (#3383).
 */
const EDGE = "[^ \\t\\n\\r\\u2028\\u2029]";
const TAIL = `${EDGE}(?:.*${EDGE})?`;

/* A tail of blanks alone is read as its last blank, so the marker is reported
 * malformed rather than read as absent. */
const GATE_RE = new RegExp(
	// eslint-disable-next-line regexp/no-super-linear-backtracking -- input is issue, comment, commit or reply text from the repo's own writers; a crafted one slows the hook, nothing worse (#4642)
	`${AT_LINE_HEAD}\\*\\*Gated until:\\*\\*[ \\t]*(${TAIL}|[ \\t])[ \\t]*$`,
	"gim",
);

/*
 * Peeled off the front of the line's tail rather than split out of it: a date
 * contains hyphens, so splitting on the reason's dash first mangles the date it
 * was meant to leave alone.
 */
const GATE_DATE = /^(\d{4}-\d{2}-\d{2})(?:[ \t]*[—–-][ \t]*(?![ \t])(.*))?$/;

/**
 * The date gate rots by being reached.
 *
 * `null` where the body carries no marker outside a fenced block. An unreadable one carries the
 * whole tail back verbatim, since which part of it was meant as the date is
 * exactly what could not be determined.
 *
 * `at` is the clock to judge against, injectable so the WITA boundary can be
 * tested at an hour the suite does not get to choose.
 *
 * @param {string} body the issue body
 * @param {number} [at] epoch ms to judge the gate against
 * @returns {null
 *   | {malformed: true, raw: string, reason: string|null, iso?: undefined, active?: undefined, daysLeft?: undefined}
 *   | {malformed?: false, raw?: undefined, iso: string, reason: string|null, active: boolean, daysLeft: number}}
 */
function gateOf(body, at = Date.now()) {
	const m = firstLiveMatch(GATE_RE, String(body || ""));
	if (!m) return null;
	const tail = requiredGroup(m, 1, GATE_RE);
	const d = GATE_DATE.exec(tail);
	const raw = d ? requiredGroup(d, 1, GATE_DATE) : tail;
	const reason = (d?.[2] || "").trim() || null;
	// Round-tripping rejects a real-looking impossible date: `2026-02-30` parses
	// in JS and silently becomes 2 March.
	const t = Date.parse(`${raw}T00:00:00Z`);
	const ok =
		d && Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === raw;
	if (!ok) return { malformed: true, raw, reason };
	/* Gated *until* the date, so the issue is takeable ON it, never on it minus
	 * one — and the day turns on the founder's clock. A gate is written in WITA
	 * and read in WITA, or every gate would hold eight hours into the morning it
	 * was meant to lapse on. */
	const daysLeft = (t - witaDay(at)) / 864e5;
	return { iso: raw, reason, active: daysLeft > 0, daysLeft };
}

const GATE_ON_RE = new RegExp(
	// eslint-disable-next-line regexp/no-super-linear-backtracking -- input is issue, comment, commit or reply text from the repo's own writers; a crafted one slows the hook, nothing worse (#4642)
	`${AT_LINE_HEAD}\\*\\*Gated on:\\*\\*[ \\t]*((?:${TAIL})?)[ \\t]*$`,
	"gim",
);

/*
 * Inside a fence from a fence-open line (```/~~~) until a fence-close of the
 * same character at least as long.
 */
const FENCE_LINE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/**
 * @param {string} body
 * @param {number} index position to test
 * @returns {boolean}
 */
function isFenced(body, index) {
	let openLen = 0;
	let openChar = "";
	for (const line of body.slice(0, index).split("\n")) {
		const f = FENCE_LINE.exec(line);
		if (!f) continue;
		const fence = requiredGroup(f, 1, FENCE_LINE);
		if (openLen === 0) {
			openLen = fence.length;
			openChar = fence.charAt(0);
		} else if (fence.charAt(0) === openChar && fence.length >= openLen) {
			openLen = 0;
		}
	}
	return openLen !== 0;
}

/**
 * @param {RegExp} re a `/gm` regex
 * @param {string} body
 * @returns {RegExpExecArray|null} the first match outside a fenced block
 */
function firstLiveMatch(re, body) {
	const local = new RegExp(re);
	let m = local.exec(body);
	while (m && isFenced(body, m.index)) m = local.exec(body);
	return m;
}

/**
 * The body's first live `**Gated on:**` line as written, for a writer that
 * replaces a body to carry over (#3636), or null.
 * @param {string} body
 * @returns {string|null}
 */
function gateOnLineOf(body) {
	return firstLiveMatch(GATE_ON_RE, body)?.[0].trim() ?? null;
}

/**
 * @param {RegExp} re a `/gm` regex
 * @param {string} body
 * @returns {RegExpExecArray[]} every match outside a fenced block
 */
function liveMatches(re, body) {
	return [...body.matchAll(new RegExp(re))].filter(
		(m) => !isFenced(body, m.index),
	);
}

/*
 * Located by their keyword rather than split out of the tail: the segments are
 * dash-separated and a condition contains dashes of its own, so splitting on the
 * dash first mangles the prose it was meant to leave alone.
 *
 * The abort clause must appear exactly once in the whole tail; `check:` is
 * optional, so at most once in whatever precedes it. A prose condition or
 * command that itself contains the literal keyword a second time is
 * indistinguishable from a real second segment, so the line is malformed rather
 * than split on a guess (mantahostels#1435).
 */
const ABANDON_SEG = /[—–-][ \t]*abandon if:[ \t]*/gi;
const CHECK_SEG = /[—–-][ \t]*check:[ \t]*/gi;

/**
 * @param {RegExp} re a `/g` regex
 * @param {string} s
 * @returns {RegExpExecArray[]}
 */
function allMatches(re, s) {
	const local = new RegExp(re);
	const found = [];
	for (let m = local.exec(s); m; m = local.exec(s)) found.push(m);
	return found;
}

/**
 * The condition gate rots by being met, with nothing to notice. `abandon if:`
 * is the only thing that ever retires one (mantahostels#1333), so it is required and a line
 * missing it is malformed. `check:` is optional, so a condition no single
 * command tests stays expressible (mantahostels#1330).
 *
 * A line is malformed on any of: no `abandon if:`, more than one `abandon if:`,
 * more than one `check:` before it, an empty condition, or an empty abort
 * clause (mantahostels#1332, mantahostels#1435). Its raw tail is reported alongside a `reason`
 * naming which of the five causes fired (mantahostels#1652: the raw tail alone reads as
 * well-formed for the duplicate-keyword cause).
 * A marker quoted inside a fenced code block is not a live gate at all and is
 * skipped rather than reported, the same as one the body never wrote (mantahostels#1435).
 *
 * Known residual: a line truncated mid-condition parses as valid-without-command
 * and holds the issue on a fragment, where the equivalent date fragment fails
 * open — accepted at mantahostels#1332, the alternative holding the issue under the one
 * clause that can ever release it.
 *
 * @param {string} body the issue body
 * @returns {null
 *   | {malformed: true, raw: string, reason: string, condition?: undefined, command?: undefined, abandonIf?: undefined}
 *   | {malformed?: false, raw?: undefined, reason?: undefined, condition: string, command: string|null, abandonIf: string}}
 */
function gateOnOf(body) {
	const b = String(body || "");
	const m = firstLiveMatch(GATE_ON_RE, b);
	if (!m) return null;
	const tail = requiredGroup(m, 1, GATE_ON_RE);
	/** @param {string} reason @returns {{malformed: true, raw: string, reason: string}} */
	const malformed = (reason) => ({ malformed: true, raw: tail, reason });

	const [a, secondAbandon] = allMatches(ABANDON_SEG, tail);
	if (!a) return malformed("no `— abandon if:`");
	if (secondAbandon) return malformed("more than one `— abandon if:`");
	const abandonIf = tail.slice(a.index + a[0].length).trim();
	if (!abandonIf) return malformed("empty `abandon if:` clause");

	const head = tail.slice(0, a.index);
	const checkMatches = allMatches(CHECK_SEG, head);
	if (checkMatches.length > 1) return malformed("more than one `— check:`");
	const [c] = checkMatches;
	const condition = (c ? head.slice(0, c.index) : head).trim();
	if (!condition) return malformed("empty condition");
	const command = c ? head.slice(c.index + c[0].length).trim() || null : null;

	return { condition, command, abandonIf };
}

const BASIS_RE = new RegExp(
	// eslint-disable-next-line regexp/no-super-linear-backtracking -- input is issue, comment, commit or reply text from the repo's own writers; a crafted one slows the hook, nothing worse (#4642)
	`${AT_LINE_HEAD}\\*\\*Gate basis:\\*\\*[ \\t]*((?:${TAIL})?)[ \\t]*$`,
	"gim",
);

/**
 * The first live `**Gate basis:**` anywhere in the body, under the gate lines'
 * own line-head and fence rules. Read by the checker only: a missing basis is
 * reported, never un-gates.
 *
 * Known residual: the rule puts the basis directly beneath its gate line, but
 * one written above it, or far from it, passes too.
 *
 * @param {string} body the issue body
 * @returns {string|null} the basis text, or null where absent or empty
 */
function basisOf(body) {
	return firstLiveMatch(BASIS_RE, String(body || ""))?.[1] || null;
}

const COUNT_WORDS = [
	"one",
	"two",
	"three",
	"four",
	"five",
	"six",
	"seven",
	"eight",
	"nine",
	"ten",
];
const COUNT = `(?:a|an|${COUNT_WORDS.join("|")}|\\d+)`;
const LONG_UNIT = "(?:days?|weeks?|months?)";
const UNIT = `(?:hours?|hrs?|${LONG_UNIT})`;
/* What may sit between a count and its unit: "7 or more days", "a full day",
 * "7 consecutive UTC days". */
const MODIFIER = "(?: or more| full| consecutive(?: UTC)?)?";
/* No window: a frequency, "once a day", "every 2 hours". */
const NOT_A_RATE = "(?<!\\b(?:once|twice|per|every) )";
/* The tail of a decimal or a range, "7.5 h", "3-4 h". */
const NOT_A_TAIL = "(?<!\\d[.,–-])";
/* No wait: a frequency, though "once 7 days pass" is one, or a span measured,
 * "in 7 h after", "past 2 days since", "20 min to 6 h after". */
const NOT_A_SPAN =
	"(?<!\\b(?:per|every|in|past) )(?<!\\b(?:once|twice) (?=an? ))(?<!\\d[.,–-])(?<!\\d ?(?:min|minutes?|h|hours?|days?) to )";
/* A count and a unit, "3-day" and "24 h" included. */
const COUNTED = `(?:\\d+ ?h|${COUNT}${MODIFIER}[ -]${UNIT})`;
const COUNTED_LONG = `${COUNT}${MODIFIER}[ -]${LONG_UNIT}`;
/* A determiner or ordinal standing for a count of one: "the week", "the first
 * full day". Read only inside a wait or a basis: on its own it is ordinary
 * prose. */
/** @param {string} unit */
const determined = (unit) => `the(?: first| next)?(?: full)? ${unit}`;
const DETERMINED = determined("(?:day|week|month)");
const WEEK_ONE = "week (?:one|1)";
const ELAPSES = "(?:pass(?:es|ed)?|elapse[sd]?|go(?:ne)? by|run|accrued)";

/*
 * A wait written as prose sets a window as surely as a gate line does (#616,
 * #672). A bare duration never matches: "N days" alone is nearly always a
 * measurement window ("in 30 days"), measured on #672. A verb of elapsing may
 * sit before "after" — "7 days pass after" (#823) — and only one, so "two
 * weeks right after launch" stays a measurement. An hour count before
 * "later" or after "after" is a threshold or a span, and so is an "N-day
 * window" (#4949). The first alternative is the reading before #4949,
 * unguarded, so nothing it refused is released.
 */
const WAIT_RE = new RegExp(
	`\\b(?:${[
		`${COUNT} ${LONG_UNIT} (?:(?:(?:pass(?:es|ed)?|elapse[sd]?|go(?:ne)? by) )?after|later|live|from now|of (?:soak|running|live))`,
		`${NOT_A_SPAN}${COUNTED} (?:(?:(?:ha(?:ve|s) )?${ELAPSES} )?(?:after|since)|live|of (?:soak|running|live))`,
		`${NOT_A_SPAN}${COUNTED_LONG} (?:later|from now)`,
		// "24 h of suite-queue logs have accrued since": up to three words, a
		// first guess fitted to that wording and unmeasured
		`${NOT_A_SPAN}${COUNTED} of [\\w-]+(?: [\\w-]+){0,2} ha(?:ve|s) ${ELAPSES} since`,
		// "the day after the merge" is ordinary prose
		`(?!the day after\\b)${DETERMINED} after`,
		// "the 24 h window after cutover", "the week of memwatch after"
		`(?:(?:the )?${NOT_A_RATE}${NOT_A_TAIL}${COUNTED}|${DETERMINED}) (?:window|of [\\w-]+) after`,
		`after ${COUNTED_LONG}`,
		`has run ${COUNTED}`,
		`${COUNT} full ${UNIT} of`,
		// "a 7-day post-rollout reading": the noun within two words
		`${NOT_A_RATE}${NOT_A_TAIL}${COUNT}-${LONG_UNIT}(?:(?: [\\w-]+)? (?:reading|soak|trial)s?| measurement windows?)`,
		WEEK_ONE,
		"no earlier than",
	].join("|")})\\b`,
	"gi",
);

/*
 * A window, as the per-window check reads one (#823). Compared by length, so
 * a basis naming "24 hours" names a gate's "a day"; a month has no fixed
 * length and matches only a month.
 */
const COUNTED_WINDOW = `${NOT_A_TAIL}(\\d+) ?(h)|(${COUNT})${MODIFIER}[ -](${UNIT})`;
const WINDOW_RE = new RegExp(`${NOT_A_RATE}\\b(?:${COUNTED_WINDOW})\\b`, "gi");
const DETERMINED_WINDOW_RE = new RegExp(
	`${NOT_A_RATE}\\b(?:${COUNTED_WINDOW}|${determined("(day|week|month)")}|(?=(week))${WEEK_ONE})\\b`,
	"gi",
);
/** @type {Record<string, number>} */
const UNIT_HOURS = { hour: 1, day: 24, week: 168 };

/**
 * @param {string} count
 * @param {string} unit
 * @returns {string} equal for two spellings of one length
 */
function durationKey(count, unit) {
	const c = count.toLowerCase();
	const n = /^an?$/.test(c) ? 1 : COUNT_WORDS.indexOf(c) + 1 || Number(c);
	const u = unit.toLowerCase().replace(/s$/, "").replace(/^hr?$/, "hour");
	const hours = UNIT_HOURS[u];
	return hours === undefined ? `${n}${u}` : `${n * hours}h`;
}

/**
 * Where a `**Gated on:**` line's `check:` command sits in it: its arguments
 * are no window.
 *
 * @param {string} line
 * @returns {[number, number]|null}
 */
function checkSpan(line) {
	const [c] = allMatches(CHECK_SEG, line);
	if (!c) return null;
	const [a] = allMatches(ABANDON_SEG, line);
	return [c.index, a && a.index > c.index ? a.index : line.length];
}

/**
 * The windows written in match `at` of `body`, skipping any inside an inline
 * code span.
 *
 * @param {string} body
 * @param {RegExpMatchArray} at
 * @param {{determined?: boolean}} [opts] `determined` reads "the week" and
 *   "week one" as windows too: a wait or a basis, never a whole gate line
 * @returns {{written: string, key: string}[]}
 */
function durationsIn(body, at, opts = {}) {
	const skip = checkSpan(at[0]);
	const re = opts.determined ? DETERMINED_WINDOW_RE : WINDOW_RE;
	return [...at[0].matchAll(re)]
		.filter((m) => {
			const i = m.index ?? 0;
			return (
				!(skip && i >= skip[0] && i < skip[1]) &&
				!inCodeSpan(body, (at.index ?? 0) + i)
			);
		})
		.map((m) => {
			const unit = m[2] ?? m[4] ?? m[5] ?? m[6];
			if (unit === undefined)
				throw new Error(`no unit group took part in a match of /${re.source}/`);
			// A determiner stands for a count of one.
			return { written: m[0], key: durationKey(m[1] ?? m[3] ?? "1", unit) };
		});
}

const basisRule = () =>
	`Every gate line, and every wait written as prose, carries a \`**Gate basis:**\` line on its own line — beneath the gate line where there is one — and the basis names every window the gate and the waits write, an \`abandon if:\` clause's included (#823). Where the body writes a window, the basis carries a warrant (#4946). Wait windows are the shortest the data defends (#616, #672). The check reads the basis's form, each window named and a warrant present, and never judges it: the derivation is the writer's. Rule: ${docPath("agents/issue-tracker.md")} §Gating an issue. ${require("./rule-text.js").readRuleTextOr("gate-basis-line", "The line is `**Gate basis:** <what sets the window, with its warrant>`", "issue-gate")}`;

const ISSUE_REF_RE = /#(\d+)\b/g;
/* `mantahostels#12` and `owner/repo#12` name another repo's issue. */
const REPO_BEFORE_REF_RE = /[\w.-]$/;
const SHA_RE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/;
const REPO_PATH_RE = /\/[\w-]+\.[a-z]+\b/;
/* A web address is no repo path. */
const URL_RE = /\bhttps?:\/\/\S+/g;
const CODE_SPAN_RE = /`[^`\n]+`/;
const FRACTION_RE = /\b(\d[\d,]*)(?:\/| of )(\d[\d,]*)\b/g;
const PERCENT_RE = /\d(?:\.\d+)? ?%/;
/* Up to four words between the figure and its period, "200 attempts a day",
 * and up to two between an issue and its event below: first guesses fitted to
 * the tracker's bases, unmeasured. */
const RATE_RE =
	/\d(?: [\w-]+){0,4} (?:a|an|per|each) (?:minute|hour|day|week|month)\b/i;
const CYCLE_RE =
	/\b(?:daily|weekly|day-of-week|weekdays?|weekends?|work units?|load cycles?|cron|cadence|sweep schedule)\b/i;
const EVENT =
	"(?:land(?:s|ed|ing)?|clos(?:e[sd]?|ing)|merg(?:e[sd]?|ing)|ship(?:s|ped|ping)?|install(?:s|ed)?|beg[ai]ns?|start(?:s|ed)?|(?:went|goes|go) live)";
/* "#4807 (the fix) landed", "#2741's archive landed": the event is said of the
 * issue. */
const EVENT_AFTER_REF_RE = new RegExp(
	`^(?:\\s*\\([^)]*\\))?(?:['’]s)?(?:\\s+[\\w-]+){0,2}\\s+${EVENT}\\b`,
	"i",
);
const EVENT_RE = new RegExp(`\\b${EVENT}\\b`, "i");
const TEMPORAL_BEFORE_REF_RE = /\b(?:after|since|once|until|when)\s+$/i;
const CLAUSE_END_RE = /[,;:](?=\s)|\.(?=\s|$)|\s[—–]\s/g;
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*";
/* A count of something: an integer before a word, zero and a date's day, year
 * or clock time excepted. */
const COUNT_OF_RE = new RegExp(
	`(?<![\\w.,/#:-])(?<!\\b${MONTH} )(?!0\\b)(\\d[\\d,]*)(?= +(?!${MONTH}\\b)[a-z])`,
	"gi",
);

/**
 * A reference that only names the event a window starts from — "#4807 landed
 * on 10 Nov", "after #4807", "the try began 27 Oct (#3278)" — says nothing of
 * the window's length, so it is no warrant.
 *
 * @param {string} basis
 * @param {RegExpMatchArray} ref
 * @returns {boolean}
 */
function isEventAnchor(basis, ref) {
	const at = ref.index ?? 0;
	const end = at + ref[0].length;
	if (EVENT_AFTER_REF_RE.test(basis.slice(end))) return true;
	const before = basis.slice(0, at);
	if (TEMPORAL_BEFORE_REF_RE.test(before)) return true;
	const clauseStart = Math.max(
		0,
		...[...before.matchAll(CLAUSE_END_RE)].map(
			(m) => (m.index ?? 0) + m[0].length,
		),
	);
	return (
		before.endsWith("(") &&
		basis.charAt(end) === ")" &&
		EVENT_RE.test(before.slice(clauseStart))
	);
}

/**
 * @param {string} basis
 * @param {number} [own] the body's own issue number
 * @returns {RegExpMatchArray[]} its references to an issue other than its own
 */
function otherIssueRefs(basis, own) {
	return [...basis.matchAll(ISSUE_REF_RE)].filter(
		(m) =>
			Number(m[1]) !== own || REPO_BEFORE_REF_RE.test(basis.slice(0, m.index)),
	);
}

/**
 * Which warrant a basis carries, read as form and never as truth (#4946).
 *
 * @param {string} basis the basis text
 * @param {number} [own] the body's own issue number: a reference to it is
 *   neither a warrant nor a source
 * @returns {"count"|"cycle"|"issue"|null}
 */
function warrantOf(basis, own) {
	const refs = otherIssueRefs(basis, own);
	if (refs.some((m) => !isEventAnchor(basis, m))) return "issue";
	const sourced =
		refs.length > 0 ||
		SHA_RE.test(basis) ||
		REPO_PATH_RE.test(basis.replace(URL_RE, "")) ||
		CODE_SPAN_RE.test(basis);
	if (!sourced) return null;
	const fractions = [...basis.matchAll(FRACTION_RE)];
	const hasBound = PERCENT_RE.test(basis) || RATE_RE.test(basis);
	if (fractions.length > 0 && hasBound) {
		const baseline = new Set(fractions.flatMap((m) => [m[1], m[2]]));
		// The count that results is no reference and no window.
		const counts = basis
			.replace(ISSUE_REF_RE, "")
			.replace(WINDOW_RE, "~")
			.matchAll(COUNT_OF_RE);
		for (const c of counts) if (!baseline.has(c[1])) return "count";
	}
	if (CYCLE_RE.test(basis) && (fractions.length > 0 || hasBound))
		return "cycle";
	return null;
}

/**
 * @typedef {{kind: "no-basis"|"unnamed-window"|"no-warrant", text: string}} BasisFault
 *   `text` is what the fault is read off, as written: a gate line or prose
 *   wait with no basis, a window no basis names, or a basis with no warrant.
 */

/**
 * What in a body needs a `**Gate basis:**` and lacks one. With no live basis:
 * the first live gate line, and each live prose wait. With one: each window a
 * live gate line or prose wait writes that no live basis names (#823), and,
 * where the body writes a window at all, each live basis carrying no warrant
 * (#4946).
 *
 * @param {string} body the issue body
 * @param {number} [own] the body's own issue number, where the caller knows it
 * @returns {BasisFault[]}
 */
function basisFaults(body, own) {
	const text = String(body || "");
	const bases = liveBases(text);
	if (bases.length === 0) {
		const gate =
			firstLiveMatch(GATE_RE, text) || firstLiveMatch(GATE_ON_RE, text);
		return [
			...(gate ? [gate[0].trim()] : []),
			...liveWaits(text).map((m) => m[0]),
		].map((t) => ({ kind: "no-basis", text: t }));
	}
	const named = new Set(
		bases.flatMap((m) =>
			durationsIn(text, m, { determined: true }).map((d) => d.key),
		),
	);
	const windows = windowsOf(text);
	/** @type {Map<string, BasisFault>} */
	const faults = new Map();
	for (const d of windows)
		if (!named.has(d.key) && !faults.has(d.written.toLowerCase()))
			faults.set(d.written.toLowerCase(), {
				kind: "unnamed-window",
				text: d.written,
			});
	if (windows.length > 0)
		for (const m of bases) {
			const basis = requiredGroup(m, 1, BASIS_RE);
			if (!warrantOf(basis, own))
				faults.set(basis.toLowerCase(), { kind: "no-warrant", text: basis });
		}
	return [...faults.values()];
}

/**
 * @param {string} text
 * @returns {RegExpMatchArray[]} its prose waits outside a fence or code span
 */
function liveWaits(text) {
	return [...text.matchAll(WAIT_RE)].filter(
		(m) => !isFenced(text, m.index) && !inCodeSpan(text, m.index),
	);
}

/**
 * The windows a body's live gate lines and prose waits write.
 *
 * @param {string} text
 * @returns {{written: string, key: string}[]}
 */
function windowsOf(text) {
	return [
		...parseLiveGateLines(text).flatMap((m) => durationsIn(text, m)),
		...liveWaits(text).flatMap((m) =>
			durationsIn(text, m, { determined: true }),
		),
	];
}

/**
 * @param {string} text
 * @returns {RegExpMatchArray[]} its gate lines of both spellings, outside a fence
 */
function parseLiveGateLines(text) {
	return [...liveMatches(GATE_RE, text), ...liveMatches(GATE_ON_RE, text)];
}

/**
 * @param {string} text
 * @returns {RegExpMatchArray[]} its non-empty basis lines, outside a fence
 */
function liveBases(text) {
	return liveMatches(BASIS_RE, text).filter((m) => m[1]);
}

/**
 * What the model reading (lib/gate-judge.js) checks a body against: each live
 * basis's text, whether the patterns read a window in it, and whether a quote
 * at `index` is live — outside a fence and a code span.
 *
 * @param {string} body
 */
function gateFacts(body) {
	const text = String(body || "");
	return {
		bases: liveBases(text).map((m) => requiredGroup(m, 1, BASIS_RE)),
		writesWindow: windowsOf(text).length > 0,
		/** @param {number} index */
		isLiveAt: (index) => !isFenced(text, index) && !inCodeSpan(text, index),
	};
}

/**
 * Inside an inline code span on its own line — a phrase quoted as an example.
 *
 * @param {string} body
 * @param {number} index
 * @returns {boolean}
 */
function inCodeSpan(body, index) {
	const lineStart = body.lastIndexOf("\n", index - 1) + 1;
	return (body.slice(lineStart, index).match(/`/g) || []).length % 2 === 1;
}

/**
 * The faults `after` has that `before` did not, so an edit is refused only for
 * what it adds and an old body stays editable. A gate line whose date changed
 * counts as added: a moved window needs its basis as much as a new one. A
 * window `before` already wrote is held too, so adding a basis beside an old
 * wait is not refused for the wait (#823). A warrant fault is its basis text,
 * so an untouched legacy basis is held and a rewritten one is judged (#4946).
 *
 * @param {string} before
 * @param {string} after
 * @param {number} [own] the issue's number
 * @returns {BasisFault[]}
 */
function introducedBasisFaults(before, after, own) {
	const b = String(before || "");
	const held = new Set(
		[
			...basisFaults(b, own).map((f) => f.text),
			...windowsOf(b).map((d) => d.written),
		].map((t) => t.toLowerCase()),
	);
	return basisFaults(after, own).filter((f) => !held.has(f.text.toLowerCase()));
}

/**
 * Resolves the two gate markers together. One gate line per issue (mantahostels#1333): a
 * body carrying both `**Gated until:**` and `**Gated on:**` gates nothing —
 * two reasons and no way to tell which is true.
 *
 * @param {string} body the issue body
 * @param {number} [at] epoch ms to judge the date gate against, forwarded to `gateOf`
 * @returns {{
 *   gate: ReturnType<typeof gateOf>,
 *   gateOn: ReturnType<typeof gateOnOf>,
 *   conflict: boolean,
 *   gateHolds: boolean,
 *   gateOnHolds: boolean,
 *   basis: string|null,
 * }}
 */
function resolveGate(body, at = Date.now()) {
	const gate = gateOf(body, at);
	const gateOn = gateOnOf(body);
	const conflict = Boolean(gate && gateOn);
	return {
		gate,
		gateOn,
		conflict,
		gateHolds: !conflict && gate?.active === true,
		gateOnHolds: !conflict && gateOn !== null && !gateOn.malformed,
		basis: basisOf(body),
	};
}

/** @type {Record<BasisFault["kind"], (quoted: string, many: boolean) => string>} */
const FAULT_SAYS = {
	"no-basis": (quoted) => `${quoted} with no \`**Gate basis:**\` line`,
	"unnamed-window": (quoted, many) =>
		`${quoted}, ${many ? "windows" : "a window"} the \`**Gate basis:**\` line does not name`,
	"no-warrant": (quoted, many) =>
		`the ${many ? "bases" : "basis"} ${quoted}, which ${many ? "carry" : "carries"} no warrant`,
};

/**
 * The refusal every write route gives, completing "<the body> carries …".
 *
 * @param {BasisFault[]} faults from basisFaults or introducedBasisFaults
 * @returns {string}
 */
function basisRefusal(faults) {
	const says = Object.entries(FAULT_SAYS).flatMap(([kind, say]) => {
		const texts = faults.filter((f) => f.kind === kind).map((f) => f.text);
		return texts.length === 0
			? []
			: [say(texts.map((t) => `"${t}"`).join(", "), texts.length > 1)];
	});
	return `${says.join("; and ")}. ${basisRule()}`;
}

/**
 * The live gate lines `after` carries that `before` did not, as written.
 *
 * @param {string} before
 * @param {string} after
 * @returns {string[]}
 */
function parseAddedGateLines(before, after) {
	/** @param {string} b */
	const lines = (b) => parseLiveGateLines(b).map((m) => m[0].trim());
	const held = new Set(lines(String(before || "")));
	return lines(String(after || "")).filter((l) => !held.has(l));
}

/**
 * Whether `after` gates an issue `before` left ungated: a reworded or removed
 * line on an issue already gated is no new gate (#3301).
 *
 * @param {string} before
 * @param {string} after
 */
const isNewlyGated = (before, after) =>
	parseLiveGateLines(String(before || "")).length === 0 &&
	parseLiveGateLines(String(after || "")).length > 0;

/**
 * The gating rule, framed, where a write adds a gate line (#823). Advice,
 * never a refusal. Null where the write adds none.
 *
 * A Node write route prints it itself because no PreToolUse hook can read a
 * piped body.
 * The caller fetches the fragment: an accessor call in lib/ would be read as
 * an emitter by every check-guard-registry.js fixture, whose store lacks it.
 *
 * @param {string} before the body before the write, "" for a create
 * @param {string} after the body the write leaves
 * @param {() => string} readRule the fragment's text; may throw
 * @returns {string|null}
 */
function gateRuleHandover(before, after, readRule) {
	if (parseAddedGateLines(before, after).length === 0) return null;
	let text;
	try {
		text = readRule();
	} catch (e) {
		// Advice, so an unreadable fragment costs the text, never the write.
		text = `The rule could not be read (${caught(e).message}) — read ${docPath("agents/issue-tracker.md")} §Gating an issue before relying on this gate.`;
	}
	return `This write adds a gate line, so here is the rule that governs it, ${docPath("agents/issue-tracker.md")} §Gating an issue:\n\n${text}\n`;
}

const MAP_LABEL = "wayfinder:map";

/* The Destination a new repo's first map is filed with, for its first session
 * to grill in (#713). */
const UNFILLED_DESTINATION = "Not named yet — the first session grills it";

/**
 * The text under a body's `## Destination` heading, trimmed.
 *
 * @param {string} body
 * @returns {string|null} null where the body has no such heading
 */
function destinationOf(body) {
	const lines = String(body || "").split("\n");
	const at = lines.findIndex((l) => /^##[ \t]+Destination$/.test(l.trimEnd()));
	if (at < 0) return null;
	const rest = lines.slice(at + 1);
	const end = rest.findIndex((l) => /^#{1,2}[ \t]/.test(l));
	return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}

/**
 * The limb's one `gh` call's arguments. `repo` omitted, gh resolves it from
 * the working directory, as the `gh issue create` it judges does.
 *
 * @param {string} [repo]
 * @returns {string[]}
 */
function openMapsArgs(repo) {
	const { ISSUE_LIST_LIMIT } = require("./gh.js");
	return [
		"issue",
		"list",
		...(repo ? ["--repo", repo] : []),
		"--label",
		MAP_LABEL,
		"--state",
		"open",
		"--json",
		"number,body",
		"--limit",
		String(ISSUE_LIST_LIMIT),
	];
}

/**
 * The limb's one `gh` call, run.
 *
 * @param {string} [repo]
 * @returns {unknown}
 */
function listOpenMaps(repo) {
	const { ghJson } = require("./gh.js");
	return ghJson(openMapsArgs(repo));
}

/**
 * The second-map limb (#717): a create carrying `wayfinder:map` is refused
 * while an open map's Destination still reads UNFILLED_DESTINATION.
 * `readMaps` is called only where `labels` carry `wayfinder:map`; an answer
 * it cannot read comes back as `unreadable`, for the caller to record and
 * file anyway.
 *
 * @param {string[]} labels the create's labels
 * @param {() => unknown} readMaps
 * @returns {null | {refusal: string} | {unreadable: string}}
 */
function secondMapVerdict(labels, readMaps) {
	if (!labels.includes(MAP_LABEL)) return null;
	let maps;
	try {
		maps = readMaps();
	} catch (e) {
		const { parseErrLine } = require("./gh.js");
		return {
			unreadable: `the open maps could not be listed (${parseErrLine(e)})`,
		};
	}
	if (!Array.isArray(maps))
		return { unreadable: "the open-map list is not a JSON array" };
	const unfilled = maps
		.filter((m) => destinationOf(m?.body) === UNFILLED_DESTINATION)
		.map((m) => m.number)
		.sort((a, b) => a - b)
		.map((n) => `#${n}`);
	if (unfilled.length === 0) return null;
	const [first] = unfilled;
	const which =
		unfilled.length === 1
			? `${first} is an open wayfinder map whose Destination`
			: `${unfilled.join(", ")} are open wayfinder maps whose Destination`;
	return {
		refusal: `${which} still reads \`${UNFILLED_DESTINATION}\`, so a second map would split this repo's first effort across two. Fill ${first} instead: run /wayfinder on it and grill its Destination in. If that effort is abandoned, close it first. Rule: the /new-repo spec's §Second-map refusal (#713, #717).`,
	};
}

module.exports = {
	gateOf,
	gateOnOf,
	gateOnLineOf,
	resolveGate,
	basisFaults,
	introducedBasisFaults,
	basisRefusal,
	gateFacts,
	otherIssueRefs,
	gateRuleHandover,
	isNewlyGated,
	parseAddedGateLines,
	MAP_LABEL,
	UNFILLED_DESTINATION,
	listOpenMaps,
	openMapsArgs,
	secondMapVerdict,
};
