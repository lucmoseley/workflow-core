const { createHash } = require("node:crypto");
const { requiredGroup } = require("./regex-group.js");
const { docPath } = require("./script-path");
const { witaDay } = require("./wita");
const { caught } = require("./caught.js");
const { parseWindow } = require("./gate-window.js");
const { REF_FORMS, refKey, scanIssueRefs } = require("./issue-ref.js");

const AT_LINE_HEAD = "^[ \\t]{0,3}";

const EDGE = "[^ \\t\\n\\r\\u2028\\u2029]";
const TAIL = `${EDGE}(?:.*${EDGE})?`;
const BLANKS = "[ \\t]*(?![ \\t])";

const GATE_RE = new RegExp(
	`${AT_LINE_HEAD}\\*\\*Gated until:\\*\\*${BLANKS}(${TAIL}|(?<=[ \\t]))[ \\t]*$`,
	"gim",
);

const GATE_DATE = /^(\d{4}-\d{2}-\d{2})(?:[ \t]*[—–-][ \t]*(?![ \t])(.*))?$/;

/**
 * @param {string} body
 * @param {number} [at]
 * @returns {null
 *   | {malformed: true, raw: string, reason: string|null, iso?: undefined, active?: undefined, daysLeft?: undefined}
 *   | {malformed?: false, raw?: undefined, iso: string, reason: string|null, active: boolean, daysLeft: number}}
 */
function gateOf(body, at = Date.now()) {
	const m = firstLiveMatch(GATE_RE, String(body || ""));
	if (!m) return null;
	const tail = requiredGroup(m, 1, GATE_RE) || m[0].slice(-1);
	const d = GATE_DATE.exec(tail);
	const raw = d ? requiredGroup(d, 1, GATE_DATE) : tail;
	const reason = (d?.[2] || "").trim() || null;
	const t = Date.parse(`${raw}T00:00:00Z`);
	const ok =
		d && Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === raw;
	if (!ok) return { malformed: true, raw, reason };
	const daysLeft = (t - witaDay(at)) / 864e5;
	return { iso: raw, reason, active: daysLeft > 0, daysLeft };
}

const GATE_ON_RE = new RegExp(
	`${AT_LINE_HEAD}\\*\\*Gated on:\\*\\*${BLANKS}((?:${TAIL})?)[ \\t]*$`,
	"gim",
);

const FENCE_LINE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/**
 * @param {string} body
 * @param {number} index
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
 * @param {RegExp} re
 * @param {string} body
 * @returns {RegExpExecArray|null}
 */
function firstLiveMatch(re, body) {
	const local = new RegExp(re);
	let m = local.exec(body);
	while (m && isFenced(body, m.index)) m = local.exec(body);
	return m;
}

/**
 * @param {string} body
 * @returns {string|null}
 */
function gateLinesOf(body) {
	const m = firstLiveMatch(GATE_ON_RE, body);
	if (m === null) return null;
	const gate = m[0].trim();
	const below = body.slice(m.index + m[0].length);
	const basis = firstLiveMatch(BASIS_RE, below)?.[0].trim();
	return basis === undefined ? gate : `${gate}\n${basis}`;
}

/**
 * @param {RegExp} re
 * @param {string} body
 * @returns {RegExpExecArray[]}
 */
function liveMatches(re, body) {
	return [...body.matchAll(new RegExp(re))].filter(
		(m) => !isFenced(body, m.index),
	);
}

const ABANDON_SEG = /[—–-][ \t]*abandon if:[ \t]*/gi;
const CHECK_SEG = /[—–-][ \t]*check:[ \t]*/gi;

/**
 * @param {RegExp} re
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
 * @param {string} body
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

/**
 * @template {string|null} S
 * @param {string} body
 * @param {S} self
 * @returns {{repo: string|S, number: number}[]}
 */
function gateRefsOf(body, self) {
	const gate = gateOnOf(body);
	if (!gate) return [];
	const owner = self?.split("/")[0] ?? null;
	/** @type {Map<string, {repo: string|S, number: number}>} */
	const out = new Map();
	for (const r of scanIssueRefs(
		gate.malformed ? gate.raw : gate.condition,
		REF_FORMS.citation,
	)) {
		const repo =
			r.name === null
				? self
				: [r.owner ?? owner, r.name].filter(Boolean).join("/");
		out.set(refKey({ repo, number: r.number }), { repo, number: r.number });
	}
	return [...out.values()];
}

const BASIS_RE = new RegExp(
	`${AT_LINE_HEAD}\\*\\*Gate basis:\\*\\*${BLANKS}((?:${TAIL})?)[ \\t]*$`,
	"gim",
);

/**
 * @param {string} body
 * @returns {string|null}
 */
function basisOf(body) {
	return firstLiveMatch(BASIS_RE, String(body || ""))?.[1] || null;
}

const OVERRIDE_RE = new RegExp(
	`${AT_LINE_HEAD}\\*\\*Gate judge override:\\*\\*${BLANKS}((?:${TAIL})?)[ \\t]*$`,
	"gim",
);

/**
 * @param {string} body
 * @returns {{reason: string}|null}
 */
function judgeOverrideOf(body) {
	const m = firstLiveMatch(OVERRIDE_RE, String(body || ""));
	return m ? { reason: requiredGroup(m, 1, OVERRIDE_RE).trim() } : null;
}

const OVERRIDE_REVIEWED_LEAD = "**Gate judge override reviewed:**";
// guess, #5673
const OVERRIDE_KEY_LENGTH = 8;
const OVERRIDE_REVIEWED_RE = new RegExp(
	`${AT_LINE_HEAD}\\*\\*Gate judge override reviewed:\\*\\*${BLANKS}([0-9a-f]{${OVERRIDE_KEY_LENGTH}})[ \\t]+—[ \\t]*\\S.*—[ \\t]*\\S`,
	"gim",
);

/** @param {string} reason */
function overrideFingerprint(reason) {
	return createHash("sha256")
		.update(reason.replace(/\s+/g, " ").trim())
		.digest("hex")
		.slice(0, OVERRIDE_KEY_LENGTH);
}

/** @param {string} key */
const overrideReviewedLine = (key) =>
	`${OVERRIDE_REVIEWED_LEAD} ${key} — <date> — <where the review is recorded>`;

/**
 * @param {string} body
 * @returns {string|null}
 */
function overrideReviewOf(body) {
	const m = firstLiveMatch(OVERRIDE_REVIEWED_RE, String(body || ""));
	return m ? requiredGroup(m, 1, OVERRIDE_REVIEWED_RE).toLowerCase() : null;
}

/**
 * #5674
 * @param {string} body
 * @param {string} [before]
 * @returns {string|null}
 */
function selfReviewRefusal(body, before = "") {
	const reason = judgeOverrideOf(body)?.reason;
	if (!reason) return null;
	const key = overrideFingerprint(reason);
	if (overrideReviewOf(body) !== key) return null;
	const was = judgeOverrideOf(before)?.reason;
	if (was && overrideFingerprint(was) === key) return null;
	return `a \`${OVERRIDE_REVIEWED_LEAD}\` line keyed to the \`**Gate judge override:**\` line this same write adds or edits, so the override would never be listed for review. Write the override alone; the review that finds it right adds the reviewed line in a later edit.`;
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
const MODIFIER = "(?: or more| full| consecutive(?: UTC)?)?";
const NOT_A_RATE = "(?<!\\b(?:once|twice|per|every) )";
const NOT_A_TAIL = "(?<!\\d[.,–-])";
const NOT_A_SPAN =
	"(?<!\\b(?:per|every|in|past) )(?<!\\b(?:once|twice) (?=an? ))(?<!\\d[.,–-])(?<!\\d ?(?:min|minutes?|h|hours?|days?) to )";
const COUNTED = `(?:\\d+ ?h|${COUNT}${MODIFIER}[ -]${UNIT})`;
const COUNTED_LONG = `${COUNT}${MODIFIER}[ -]${LONG_UNIT}`;
/** @param {string} unit */
const buildDetermined = (unit) => `the(?: first| next)?(?: full)? ${unit}`;
const DETERMINED = buildDetermined("(?:day|week|month)");
const WEEK_ONE = "week (?:one|1)";
const ELAPSES = "(?:pass(?:es|ed)?|elapse[sd]?|go(?:ne)? by|run|accrued)";

const WAIT_RE = new RegExp(
	`\\b(?:${[
		`${COUNT} ${LONG_UNIT} (?:(?:(?:pass(?:es|ed)?|elapse[sd]?|go(?:ne)? by) )?after|later|live|from now|of (?:soak|running|live))`,
		`${NOT_A_SPAN}${COUNTED} (?:(?:(?:ha(?:ve|s) )?${ELAPSES} )?(?:after|since)|live|of (?:soak|running|live))`,
		`${NOT_A_SPAN}${COUNTED_LONG} (?:later|from now)`,
		// guess, #4949
		`${NOT_A_SPAN}${COUNTED} of [\\w-]+(?: [\\w-]+){0,2} ha(?:ve|s) ${ELAPSES} since`,
		`(?!the day after\\b)${DETERMINED} after`,
		`(?:(?:the )?${NOT_A_RATE}${NOT_A_TAIL}${COUNTED}|${DETERMINED}) (?:window|of [\\w-]+) after`,
		`after ${COUNTED_LONG}`,
		`has run ${COUNTED}`,
		`${COUNT} full ${UNIT} of`,
		`${NOT_A_RATE}${NOT_A_TAIL}${COUNT}-${LONG_UNIT}(?:(?: [\\w-]+)? (?:reading|soak|trial)s?| measurement windows?)`,
		WEEK_ONE,
		"no earlier than",
	].join("|")})\\b`,
	"gi",
);

const COUNTED_WINDOW = `${NOT_A_TAIL}(\\d+) ?(h)|(${COUNT})${MODIFIER}[ -](${UNIT})`;
const WINDOW_RE = new RegExp(`${NOT_A_RATE}\\b(?:${COUNTED_WINDOW})\\b`, "gi");
const DETERMINED_WINDOW_RE = new RegExp(
	`${NOT_A_RATE}\\b(?:${COUNTED_WINDOW}|${buildDetermined("(day|week|month)")}|(?=(week))${WEEK_ONE})\\b`,
	"gi",
);
/** @type {Record<string, number>} */
const UNIT_HOURS = { hour: 1, day: 24, week: 168 };

/**
 * @param {string} count
 * @param {string} unit
 * @returns {string}
 */
function durationKey(count, unit) {
	const c = count.toLowerCase();
	const n = /^an?$/.test(c) ? 1 : COUNT_WORDS.indexOf(c) + 1 || Number(c);
	const u = unit.toLowerCase().replace(/s$/, "").replace(/^hr?$/, "hour");
	const hours = UNIT_HOURS[u];
	return hours === undefined ? `${n}${u}` : `${n * hours}h`;
}

/**
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
 * @param {string} body
 * @param {RegExpMatchArray} at
 * @param {{determined?: boolean}} [opts]
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
			return { written: m[0], key: durationKey(m[1] ?? m[3] ?? "1", unit) };
		});
}

const basisRule = () =>
	`Every gate line, and every wait written as prose, carries a \`**Gate basis:**\` line on its own line — beneath the gate line where there is one — and the basis names every window the gate and the waits write, an \`abandon if:\` clause's included (#823). Wait windows are the shortest the data defends (#616, #672). The wording patterns read the basis's form, each window named and a warrant present; a model reading also asks which sentences make work wait and whether each basis derives its window, and refuses a wait or basis it faults. Rule: ${docPath("agents/issue-tracker.md")} §Gating an issue. ${require("./rule-text.js").readRuleTextOr("gate-basis-line", "The line is `**Gate basis:** <what sets the window, with its warrant>`", "issue-gate")}`;

const ISSUE_REF_RE = /#(\d+)\b/g;
const REPO_BEFORE_REF_RE = /[\w.-]$/;
const SHA_RE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/;
const REPO_PATH_RE = /\/[\w-]+\.[a-z]+\b/;
const URL_RE = /\bhttps?:\/\/\S+/g;
const CODE_SPAN_RE = /`[^`\n]+`/;
const FRACTION_RE = /\b(\d[\d,]*)(?:\/| of )(\d[\d,]*)\b/g;
const PERCENT_RE = /\d(?:\.\d+)? ?%/;
// guess, #4949
const RATE_RE =
	/\d(?: [\w-]+){0,4} (?:a|an|per|each) (?:minute|hour|day|week|month)\b/i;
const CYCLE_RE =
	/\b(?:daily|weekly|day-of-week|weekdays?|weekends?|work units?|load cycles?|cron|cadence|sweep schedule)\b/i;
const EVENT =
	"(?:land(?:s|ed|ing)?|clos(?:e[sd]?|ing)|merg(?:e[sd]?|ing)|ship(?:s|ped|ping)?|install(?:s|ed)?|beg[ai]ns?|start(?:s|ed)?|(?:went|goes|go) live)";
// guess, #4949
const EVENT_AFTER_REF_RE = new RegExp(
	`^(?:\\s*\\([^)]*\\))?(?:['’]s)?(?:\\s+[\\w-]+){0,2}\\s+${EVENT}\\b`,
	"i",
);
const EVENT_RE = new RegExp(`\\b${EVENT}\\b`, "i");
const TEMPORAL_BEFORE_REF_RE = /\b(?:after|since|once|until|when)\s+$/i;
const CLAUSE_END_RE = /[,;:](?=\s)|\.(?=\s|$)|\s[—–]\s/g;
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*";
const COUNT_OF_RE = new RegExp(
	`(?<![\\w.,/#:-])(?<!\\b${MONTH} )(?!0\\b)(\\d[\\d,]*)(?= +(?!${MONTH}\\b)[a-z])`,
	"gi",
);

/**
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
 * @param {number} [own]
 * @returns {RegExpMatchArray[]}
 */
function otherIssueRefs(basis, own) {
	return [...basis.matchAll(ISSUE_REF_RE)].filter(
		(m) =>
			Number(m[1]) !== own || REPO_BEFORE_REF_RE.test(basis.slice(0, m.index)),
	);
}

/**
 * @param {string} basis
 * @param {number} [own]
 * @returns {"count"|"cycle"|"issue"|null}
 */
function warrantOf(basis, own) {
	const refs = otherIssueRefs(basis, own);
	return (
		ownWarrantOf(basis, refs) ??
		(refs.some((m) => !isEventAnchor(basis, m)) ? "issue" : null)
	);
}

/**
 * @param {string} basis
 * @param {RegExpMatchArray[]} refs
 * @returns {"count"|"cycle"|null}
 */
function ownWarrantOf(basis, refs) {
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

const REPO_PREFIX_RE = /(?<![\w./-])([\w.-]+(?:\/[\w.-]+)?)$/;
const ROUND_AFTER_REF_RE = /^\s+(Q\d+)\b/;

/**
 * @typedef {{repo: string, number: number, round: string|null,
 *   written: string}} CitedRef
 * @typedef {{texts: string[]}} CitedIssue
 * @typedef {"no-basis"|"no-window"|"no-own-warrant"|"no-round"} CitedReason
 * @typedef {{basis: string, cited: {ref: string, key: string, repo: string,
 *   number: number, verdict: "stands"|"unread"|CitedReason}[]}} FollowRecord
 * @typedef {{tracker: string, issues: Map<string, CitedIssue|null>,
 *   skip?: Set<string>, trace?: FollowRecord[]}} Follow
 */

/**
 * @param {string} prefix
 * @param {string} tracker
 */
function citedRepo(prefix, tracker) {
	if (!prefix) return tracker.toLowerCase();
	if (prefix.includes("/")) return prefix.toLowerCase();
	return `${tracker.split("/")[0]}/${prefix}`.toLowerCase();
}

/** @param {{repo: string, number: number}} ref */
const citedKey = (ref) => `${ref.repo}#${ref.number}`;

/**
 * @param {string} basis
 * @param {number|undefined} own
 * @param {string} tracker
 * @returns {CitedRef[]}
 */
function citedRefsOf(basis, own, tracker) {
	const home = tracker.toLowerCase();
	return otherIssueRefs(basis, own)
		.filter((m) => !isEventAnchor(basis, m))
		.map((m) => {
			const at = m.index ?? 0;
			const prefix = REPO_PREFIX_RE.exec(basis.slice(0, at))?.[1] ?? "";
			const round =
				ROUND_AFTER_REF_RE.exec(basis.slice(at + m[0].length))?.[1] ?? null;
			return {
				repo: citedRepo(prefix, tracker),
				number: Number(m[1]),
				round,
				written: `${prefix}${m[0]}${round ? ` ${round}` : ""}`,
			};
		})
		.filter((ref) => ref.repo !== home || ref.number !== own);
}

/**
 * @param {CitedRef} ref
 * @param {CitedIssue|null} issue
 * @param {Set<string>} windows
 * @returns {CitedReason|null}
 */
function citedFault(ref, issue, windows) {
	if (!issue) return "no-basis";
	if (ref.round) {
		const marker = `**${ref.round}**`;
		const live = (/** @type {string} */ t) => {
			for (
				let at = t.indexOf(marker);
				at !== -1;
				at = t.indexOf(marker, at + 1)
			)
				if (!isFenced(t, at) && !inCodeSpan(t, at)) return true;
			return false;
		};
		return issue.texts.some(live) ? null : "no-round";
	}
	const bases = issue.texts.flatMap((t) =>
		liveBases(t)
			.filter((m) => !inCodeSpan(t, m.index ?? 0))
			.map((m) => ({ t, m })),
	);
	if (bases.length === 0) return "no-basis";
	const naming = bases.filter(({ t, m }) =>
		durationsIn(t, m, { determined: true }).some((d) => windows.has(d.key)),
	);
	if (naming.length === 0) return "no-window";
	return naming.some(({ m }) => {
		const w = warrantOf(requiredGroup(m, 1, BASIS_RE), ref.number);
		return w === "count" || w === "cycle";
	})
		? null
		: "no-own-warrant";
}

/**
 * @param {RegExpMatchArray[]} bases
 * @returns {WordedFault[]}
 */
function windowFaults(bases) {
	return bases.flatMap((m) => {
		const basis = requiredGroup(m, 1, BASIS_RE);
		const w = parseWindow(basis);
		if (!w || w.holds) return [];
		const { stated, computed, says } = w;
		return [
			{
				kind: /** @type {const} */ ("window-mismatch"),
				text: basis,
				words: basis,
				recomputed: { stated, computed, says },
			},
		];
	});
}

/**
 * @param {string} text
 * @param {RegExpMatchArray} m
 * @param {number|undefined} own
 * @param {Follow} follow
 * @returns {{ref: string, reason: CitedReason}[]|null}
 */
function followCited(text, m, own, follow) {
	const basis = requiredGroup(m, 1, BASIS_RE);
	const refs = citedRefsOf(basis, own, follow.tracker);
	const windows = new Set(
		durationsIn(text, m, { determined: true }).map((d) => d.key),
	);
	const verdicts = refs.map((ref) => {
		const key = citedKey(ref);
		const issue = follow.issues.get(key);
		return {
			ref,
			key,
			verdict:
				issue === undefined
					? "unread"
					: (citedFault(ref, issue, windows) ?? "stands"),
		};
	});
	follow.trace?.push({
		basis,
		cited: verdicts.map((v) => ({
			ref: v.ref.written,
			key: v.key,
			repo: v.ref.repo,
			number: v.ref.number,
			verdict: /** @type {FollowRecord["cited"][number]["verdict"]} */ (
				v.verdict
			),
		})),
	});
	if (verdicts.some((v) => v.verdict === "stands" || v.verdict === "unread"))
		return null;
	return verdicts.map((v) => ({
		ref: v.ref.written,
		reason: /** @type {CitedReason} */ (v.verdict),
	}));
}

/**
 * @typedef {{kind: "no-basis"|"unnamed-window"|"no-warrant"|"window-mismatch",
 *   text: string, cited?: {ref: string, reason: CitedReason}[],
 *   recomputed?: {stated: string, computed: string, says: string}}} BasisFault
 * @typedef {BasisFault & {words: string, window?: string}} WordedFault
 */

/**
 * @param {string} body
 * @param {number} [own]
 * @param {Follow} [follow]
 * @returns {BasisFault[]}
 */
function basisFaults(body, own, follow) {
	return wordedBasisFaults(body, own, follow).map(bareFault);
}

/**
 * @param {string} body
 * @param {number} [own]
 * @param {Follow} [follow]
 * @returns {WordedFault[]}
 */
function wordedBasisFaults(body, own, follow) {
	const text = String(body || "");
	const bases = liveBases(text);
	if (bases.length === 0) {
		const gate =
			firstLiveMatch(GATE_RE, text) || firstLiveMatch(GATE_ON_RE, text);
		const line = gate?.[0].trim();
		return [
			...(line ? [{ text: line, words: line }] : []),
			...liveWaits(text).map((m) => ({
				text: m[0],
				words: sentenceOf(text, m),
			})),
		].map((f) => ({ kind: "no-basis", ...f }));
	}
	const named = new Set(
		bases.flatMap((m) =>
			durationsIn(text, m, { determined: true }).map((d) => d.key),
		),
	);
	const windows = windowsOf(text);
	/** @type {Map<string, WordedFault>} */
	const faults = new Map();
	for (const d of windows)
		if (!named.has(d.key) && !faults.has(d.written.toLowerCase()))
			faults.set(d.written.toLowerCase(), {
				kind: "unnamed-window",
				text: d.written,
				words: d.words,
				window: d.written,
			});
	if (windows.length > 0)
		for (const m of bases) {
			const fault = warrantFault(text, m, own, follow);
			if (fault) faults.set(fault.text.toLowerCase(), fault);
		}
	return [...faults.values(), ...windowFaults(bases)];
}

/**
 * @param {string} text
 * @param {RegExpMatchArray} m
 * @param {number|undefined} own
 * @param {Follow|undefined} follow
 * @returns {WordedFault|null}
 */
function warrantFault(text, m, own, follow) {
	const basis = requiredGroup(m, 1, BASIS_RE);
	const warrant = warrantOf(basis, own);
	if (!warrant) return { kind: "no-warrant", text: basis, words: basis };
	if (warrant !== "issue" || !follow || follow.skip?.has(basis.toLowerCase()))
		return null;
	const cited = followCited(text, m, own, follow);
	return cited
		? { kind: "no-warrant", text: basis, cited, words: basis }
		: null;
}

/**
 * @param {string} text
 * @returns {RegExpMatchArray[]}
 */
function liveWaits(text) {
	return [...text.matchAll(WAIT_RE)].filter(
		(m) => !isFenced(text, m.index) && !inCodeSpan(text, m.index),
	);
}

/**
 * @param {string} text
 * @returns {{written: string, key: string, words: string}[]}
 */
function windowsOf(text) {
	return [
		...parseLiveGateLines(text).flatMap((m) =>
			durationsIn(text, m).map((d) => ({ ...d, words: m[0].trim() })),
		),
		...liveWaits(text).flatMap((m) =>
			durationsIn(text, m, { determined: true }).map((d) => ({
				...d,
				words: sentenceOf(text, m),
			})),
		),
	];
}

const SENTENCE_END_RE = /[.!?](?=\s)|\n/g;

/**
 * @param {string} text
 * @param {RegExpMatchArray} m
 */
function sentenceOf(text, m) {
	const at = m.index ?? 0;
	const end = at + m[0].length;
	let from = 0;
	for (const e of text.slice(0, at).matchAll(SENTENCE_END_RE))
		from = (e.index ?? 0) + 1;
	const stop = text.slice(end).search(/[.!?](?=\s|$)|\n/);
	return text.slice(from, stop === -1 ? text.length : end + stop + 1).trim();
}

/**
 * @param {string} text
 * @returns {RegExpMatchArray[]}
 */
function parseLiveGateLines(text) {
	return [...liveMatches(GATE_RE, text), ...liveMatches(GATE_ON_RE, text)];
}

/**
 * @param {string} text
 * @returns {RegExpMatchArray[]}
 */
function liveBases(text) {
	return liveMatches(BASIS_RE, text).filter((m) => m[1]);
}

/** @param {string} body */
function gateFacts(body) {
	const text = String(body || "");
	return {
		bases: liveBases(text).map((m) => requiredGroup(m, 1, BASIS_RE)),
		writesWindow: windowsOf(text).length > 0,
		/** @param {number} index */
		isLiveAt: (index) => !isFenced(text, index) && !inCodeSpan(text, index),
	};
}

const OWN_LINE_BLOCK =
	/^[ \t]{0,3}(?:#{1,6}(?:[ \t]|$)|`{3,}|~{3,}|(?:[-*_][ \t]*){3,}$|=+[ \t]*$|-+[ \t]*$|\|)/;
const LIST_ITEM = /^[ \t]{0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const QUOTE_MARKER = /^[ \t]{0,3}>[ \t]?/;

/** @typedef {{depth: number, blank: boolean, ownLine: boolean, item: boolean}} LineShape */

/**
 * @param {string} line
 * @returns {LineShape}
 */
function lineShape(line) {
	let depth = 0;
	let rest = line;
	for (let m = QUOTE_MARKER.exec(rest); m; m = QUOTE_MARKER.exec(rest)) {
		depth++;
		rest = rest.slice(m[0].length);
	}
	return {
		depth,
		blank: rest.trim() === "",
		ownLine: OWN_LINE_BLOCK.test(rest),
		item: LIST_ITEM.test(rest),
	};
}

/**
 * @param {LineShape|null} prev
 * @param {LineShape} line
 * @returns {boolean}
 */
function opensBlock(prev, line) {
	if (prev === null || prev.blank || prev.ownLine) return true;
	return line.blank || line.ownLine || line.item || line.depth > prev.depth;
}

/**
 * @param {string} body
 * @param {number} index
 * @returns {[number, number]}
 */
function blockAround(body, index) {
	let from = 0;
	let at = 0;
	/** @type {LineShape|null} */
	let prev = null;
	for (const line of body.split("\n")) {
		const shape = lineShape(line);
		if (opensBlock(prev, shape)) {
			if (at > index) return [from, at - 1];
			from = at;
		}
		prev = shape;
		at += line.length + 1;
	}
	return [from, body.length];
}

/**
 * @param {string} body
 * @param {number} index
 * @returns {boolean}
 */
function inCodeSpan(body, index) {
	const [from, to] = blockAround(body, index);
	const runs = parseBacktickRuns(body.slice(from, to), from);
	let resume = 0;
	for (const run of runs) {
		if (run.k < resume || run.opens === 0) continue;
		if (run.opensAt > index) return false;
		const close = runs.find((r) => r.k > run.k && r.len === run.opens);
		if (close === undefined) continue;
		if (index > run.opensAt && index < close.at + close.len) return true;
		resume = close.k + 1;
	}
	return false;
}

/**
 * @param {string} block
 * @param {number} from
 * @returns {{k: number, at: number, len: number, opensAt: number, opens: number}[]}
 */
function parseBacktickRuns(block, from) {
	return [...block.matchAll(/`+/g)].map((m, k) => {
		const escaped = /(?:^|[^\\])(?:\\\\)*\\$/.test(block.slice(0, m.index))
			? 1
			: 0;
		const at = from + m.index;
		const len = m[0].length;
		return { k, at, len, opensAt: at + escaped, opens: len - escaped };
	});
}

/** @typedef {{body: string, own?: number, before?: string}} BasisWrite */

/**
 * @template {WordedFault} F
 * @param {F[]} faults
 * @param {BasisWrite} write
 * @returns {Omit<F, "words"|"window">[]}
 */
function faultsAdded(faults, { body, before }) {
	if (before === undefined) return faults.map(bareFault);
	const b = String(before);
	const facts = gateFacts(b);
	const untouched = untouchedBases(b, body);
	const owedWarrant = facts.writesWindow || !gateFacts(body).writesWindow;
	const isHeld = (/** @type {F} */ f) => {
		if (f.kind === "no-warrant")
			return owedWarrant && untouched.has(f.words.toLowerCase());
		if (f.kind === "window-mismatch")
			return untouched.has(f.words.toLowerCase());
		return (
			isLiveQuote(b, f.words, f.window ?? "", facts.isLiveAt) &&
			(f.kind === "unnamed-window" || facts.bases.length === 0)
		);
	};
	return faults.filter((f) => !isHeld(f)).map(bareFault);
}

/**
 * @template {WordedFault} F
 * @param {F} f
 * @returns {Omit<F, "words"|"window">}
 */
const bareFault = ({ words: _words, window: _window, ...f }) => f;

/**
 * @param {string} before
 * @param {string} after
 * @returns {Set<string>}
 */
const untouchedBases = (before, after) =>
	new Set(
		isRegate(before, after)
			? []
			: liveBases(before).map((m) =>
					requiredGroup(m, 1, BASIS_RE).toLowerCase(),
				),
	);

/**
 * @param {string} body
 * @param {string} quote
 * @param {string} inner
 * @param {(index: number) => boolean} isLiveAt
 */
function isLiveQuote(body, quote, inner, isLiveAt) {
	if (quote.trim() === "") return false;
	const isLive = (/** @type {number} */ from, /** @type {number} */ length) =>
		isLiveAt(from) && isLiveAt(from + length);
	const innerAt = inner ? quote.indexOf(inner) : -1;
	for (
		let at = body.indexOf(quote);
		at !== -1;
		at = body.indexOf(quote, at + 1)
	)
		if (
			isLive(at, quote.length) &&
			(innerAt === -1 || isLive(at + innerAt, inner.length))
		)
			return true;
	return false;
}

/**
 * @param {string} before
 * @param {string} after
 */
const isRegate = (before, after) =>
	parseAddedGateLines(before, after).length > 0;

/**
 * @param {string} body
 * @param {number} [at]
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

/**
 * @param {string} body
 * @param {number} [at]
 */
function isGateHolding(body, at = Date.now()) {
	const { gateHolds, gateOnHolds } = resolveGate(body, at);
	return gateHolds || gateOnHolds;
}

/** @type {Record<CitedReason, string>} */
const CITED_SAYS = {
	"no-basis": "which has no `**Gate basis:**` line",
	"no-window": "whose bases name none of its windows",
	"no-own-warrant":
		"whose basis naming its window carries no count or cycle warrant of its own",
	"no-round": "where that question round is not found",
};

/** @param {BasisFault} f */
const recomputedSays = ({ recomputed: r }) =>
	r
		? ` (it states n = ${r.stated}, where ${r.says} gives n = ${r.computed})`
		: "";

/** @param {BasisFault} f */
function citedSays(f) {
	if (!f.cited?.length) return "";
	return ` (it cites ${f.cited.map((c) => `${c.ref}, ${CITED_SAYS[c.reason]}`).join("; and ")})`;
}

/** @type {Record<BasisFault["kind"], (quoted: string, many: boolean) => string>} */
const FAULT_SAYS = {
	"no-basis": (quoted) => `${quoted} with no \`**Gate basis:**\` line`,
	"unnamed-window": (quoted, many) =>
		`${quoted}, ${many ? "windows" : "a window"} the \`**Gate basis:**\` line does not name`,
	"no-warrant": (quoted, many) =>
		`the ${many ? "bases" : "basis"} ${quoted}, which ${many ? "carry" : "carries"} no warrant`,
	"window-mismatch": (quoted, many) =>
		`the ${many ? "bases" : "basis"} ${quoted}, whose own figures do not give the window ${many ? "they state" : "it states"}`,
};

/**
 * @param {BasisFault[]} faults
 * @param {string} [reading]
 * @returns {string}
 */
function basisRefusal(faults, reading) {
	const says = Object.entries(FAULT_SAYS).flatMap(([kind, say]) => {
		const of = faults.filter((f) => f.kind === kind);
		return of.length === 0
			? []
			: [
					say(
						of
							.map((f) => `"${f.text}"${citedSays(f)}${recomputedSays(f)}`)
							.join(", "),
						of.length > 1,
					),
				];
	});
	return `${says.join("; and ")}${reading ? `, as ${reading} read it` : ""}. ${basisRule()}`;
}

/**
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
 * @param {string} before
 * @param {string} after
 */
const isNewlyGated = (before, after) =>
	parseLiveGateLines(String(before || "")).length === 0 &&
	parseLiveGateLines(String(after || "")).length > 0;

/**
 * @param {string} before
 * @param {string} after
 * @param {() => string} readRule
 * @returns {string|null}
 */
function gateRuleHandover(before, after, readRule) {
	if (parseAddedGateLines(before, after).length === 0) return null;
	let text;
	try {
		text = readRule();
	} catch (e) {
		text = `The rule could not be read (${caught(e).message}) — read ${docPath("agents/issue-tracker.md")} §Gating an issue before relying on this gate.`;
	}
	return `This write adds a gate line, so here is the rule that governs it, ${docPath("agents/issue-tracker.md")} §Gating an issue:\n\n${text}\n`;
}

const MAP_LABEL = "wayfinder:map";

const UNFILLED_DESTINATION = "Not named yet — the first session grills it";

/**
 * @param {string} body
 * @returns {string|null}
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
 * @param {string} [repo]
 * @param {import("./gh.js").GhRun} [run]
 * @returns {unknown}
 */
function listOpenMaps(repo, run) {
	const { gh, ghJson } = require("./gh.js");
	return ghJson(openMapsArgs(repo), {}, run ?? gh);
}

/**
 * @param {string[]} labels
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
	gateRefsOf,
	gateLinesOf,
	resolveGate,
	isGateHolding,
	basisFaults,
	faultsAdded,
	basisRefusal,
	citedSays,
	recomputedSays,
	basisRule,
	gateFacts,
	judgeOverrideOf,
	overrideFingerprint,
	overrideReviewOf,
	overrideReviewedLine,
	selfReviewRefusal,
	otherIssueRefs,
	gateRuleHandover,
	citedKey,
	isNewlyGated,
	isLiveQuote,
	untouchedBases,
	wordedBasisFaults,
	parseAddedGateLines,
	MAP_LABEL,
	UNFILLED_DESTINATION,
	listOpenMaps,
	openMapsArgs,
	secondMapVerdict,
};
