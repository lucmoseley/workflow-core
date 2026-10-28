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
 *   **Gate basis:** <the data that sets the date or window, and why nothing
 *       sooner fits it>  (#577)
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

const GATE_RE = new RegExp(
	`${AT_LINE_HEAD}\\*\\*Gated until:\\*\\*[ \\t]*(.+?)[ \\t]*$`,
	"gim",
);

/*
 * Peeled off the front of the line's tail rather than split out of it: a date
 * contains hyphens, so splitting on the reason's dash first mangles the date it
 * was meant to leave alone.
 */
const GATE_DATE = /^(\d{4}-\d{2}-\d{2})(?:[ \t]*[—–-][ \t]*(.*))?$/;

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
	`${AT_LINE_HEAD}\\*\\*Gated on:\\*\\*[ \\t]*(.*?)[ \\t]*$`,
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
const ABANDON_SEG = /[ \t]*[—–-][ \t]*abandon if:[ \t]*/gi;
const CHECK_SEG = /[ \t]*[—–-][ \t]*check:[ \t]*/gi;

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
	`${AT_LINE_HEAD}\\*\\*Gate basis:\\*\\*[ \\t]*(.*?)[ \\t]*$`,
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
const UNIT = "(?:weeks?|days?|months?)";

/*
 * A wait written as prose sets a window as surely as a gate line does (#616,
 * #672). A bare duration never matches: "N days" alone is nearly always a
 * measurement window ("in 30 days"), measured on #672. A verb of elapsing may
 * sit before "after" — "7 days pass after" (#823) — and only one, so "two
 * weeks right after launch" stays a measurement.
 */
const WAIT_RE = new RegExp(
	`\\b(?:${COUNT} ${UNIT} (?:(?:(?:pass(?:es|ed)?|elapse[sd]?|go(?:ne)? by) )?after|later|live|from now|of (?:soak|running|live))|after ${COUNT} ${UNIT}|no earlier than)\\b`,
	"gi",
);

/*
 * A window, as the per-window check reads one (#823): a count and a unit,
 * "3-day" included. Compared by length, so a basis naming "24 hours" names a
 * gate's "a day"; a month has no fixed length and matches only a month. A
 * frequency — "once a day", "every 2 hours" — is no window.
 */
const DURATION_RE = new RegExp(
	`(?<!\\b(?:once|twice|per|every) )\\b(${COUNT})[ -](hours?|${UNIT})\\b`,
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
	const u = unit.toLowerCase().replace(/s$/, "");
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
 * @returns {{written: string, key: string}[]}
 */
function durationsIn(body, at) {
	const skip = checkSpan(at[0]);
	return [...at[0].matchAll(DURATION_RE)]
		.filter((m) => {
			const i = m.index ?? 0;
			return (
				!(skip && i >= skip[0] && i < skip[1]) &&
				!inCodeSpan(body, (at.index ?? 0) + i)
			);
		})
		.map((m) => ({
			written: m[0],
			key: durationKey(
				requiredGroup(m, 1, DURATION_RE),
				requiredGroup(m, 2, DURATION_RE),
			),
		}));
}

const BASIS_RULE =
	"Every gate line, and every wait written as prose, carries `**Gate basis:** <the data that sets the date or window, and why nothing sooner fits it>` on its own line — beneath the gate line where there is one — and the basis names every window the gate and the waits write, an `abandon if:` clause's included (#823). Wait windows are the shortest the data defends (#616, #672). This checks only that a basis names each window, never that it holds up: the derivation is the writer's. Rule: " +
	`${docPath("agents/issue-tracker.md")} §Gating an issue.`;

/**
 * What in a body needs a `**Gate basis:**` and lacks one. With no live basis:
 * the first live gate line, and each live prose wait, as written. With one:
 * each window (DURATION_RE) a live gate line or prose wait writes that no live
 * basis names (#823).
 *
 * @param {string} body the issue body
 * @returns {string[]}
 */
function basisFaults(body) {
	const text = String(body || "");
	const bases = liveBases(text);
	if (bases.length === 0) {
		const faults = [];
		const gate =
			firstLiveMatch(GATE_RE, text) || firstLiveMatch(GATE_ON_RE, text);
		if (gate) faults.push(gate[0].trim());
		for (const m of liveWaits(text)) faults.push(m[0]);
		return faults;
	}
	const named = new Set(
		bases.flatMap((m) => durationsIn(text, m).map((d) => d.key)),
	);
	/** @type {Map<string, string>} */
	const unnamed = new Map();
	for (const d of windowsOf(text))
		if (!named.has(d.key) && !unnamed.has(d.written.toLowerCase()))
			unnamed.set(d.written.toLowerCase(), d.written);
	return [...unnamed.values()];
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
	return [...parseLiveGateLines(text), ...liveWaits(text)].flatMap((m) =>
		durationsIn(text, m),
	);
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
 * wait is not refused for the wait (#823).
 *
 * @param {string} before
 * @param {string} after
 * @returns {string[]}
 */
function introducedBasisFaults(before, after) {
	const b = String(before || "");
	const held = new Set(
		[...basisFaults(b), ...windowsOf(b).map((d) => d.written)].map((f) =>
			f.toLowerCase(),
		),
	);
	return basisFaults(after).filter((f) => !held.has(f.toLowerCase()));
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

/**
 * The refusal every write route gives, completing "<the body> carries …".
 *
 * @param {string[]} faults from basisFaults or introducedBasisFaults
 * @param {string} body the body they were read from
 * @returns {string}
 */
function basisRefusal(faults, body) {
	const quoted = faults.map((f) => `"${f}"`).join(", ");
	if (liveBases(String(body || "")).length === 0)
		return `${quoted} with no \`**Gate basis:**\` line. ${BASIS_RULE}`;
	const which =
		faults.length === 1
			? "a window the `**Gate basis:**` line does not name"
			: "windows the `**Gate basis:**` line does not name";
	return `${quoted}, ${which}. ${BASIS_RULE}`;
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
	const { ISSUE_LIST_LIMIT } = require("./gh-limits.js");
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
	resolveGate,
	basisFaults,
	introducedBasisFaults,
	basisRefusal,
	gateRuleHandover,
	isNewlyGated,
	MAP_LABEL,
	UNFILLED_DESTINATION,
	listOpenMaps,
	openMapsArgs,
	secondMapVerdict,
};
