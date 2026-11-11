/*
 * escape-audit.js — the escape-line audit's reading half (#671 step 3): which
 * close-rivals rounds got past `guard-priced-options.js`, and what the judge
 * made of each.
 *
 * `audit-escape-lines.js` owns the judging and the report; this file owns the
 * extraction and the two stores.
 *
 * WHAT COUNTS AS GETTING PAST. A `❓ **Qn**` block in an assistant text record
 * where the next user record that is not a tool result is not a Stop hook's
 * feedback. A text record followed by a tool call before any such user record
 * was not the turn's last message, so the Stop guard never read it, and it is
 * dropped. RESIDUAL: a transcript cut off mid-turn commits its last text as
 * passed.
 *
 * FIRST SIGHT OR AFTER REFUSAL. After refusal where an earlier close-rivals
 * refusal named the block's question in its flagged lines and still holds:
 * then every re-send is taken, close or not, escape line or not, paired with
 * the block as first refused and what came since (#4945, #5003). A refusal
 * holds, as the guard's record does (`refusal-limb.js` `liveRecord`), until
 * the founder speaks or the question passes. RESIDUAL: a re-send pairs by
 * round number, as the guard does, so a question renumbered into a refused
 * one's slot is judged against the wrong refused block. First sight, a block is taken
 * only where its top two rivals are close (`rivalPair`) and it carries a
 * non-empty escape line. A send is committed as passed at the next user
 * record that is neither a tool result nor Stop feedback — a task
 * notification or a mod's delivery too.
 *
 * THE STORES live in the markers directory under a prefix no sweep family
 * claims, so they outlive the 24 h marker sweep: the items index (rewritten
 * whole by each batch run, carrying no question text) and the verdict log
 * (append-only JSONL, the last line per key winning).
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./atomic-write.js");
const { markersDir } = require("./marker-root.js");
const { STOP_FEEDBACK, mainChainRecords } = require("./transcript");
const { isFounderMessage } = require("./tool-calls-since.js");
const { requiredGroup } = require("./regex-group.js");
const { caught } = require("./caught.js");
const { readJsonl } = require("./jsonl.js");

const ITEMS_NAME = ".escape-audit-items.json";
const VERDICTS_NAME = ".escape-audit-verdicts.jsonl";

/* The windows the ticket names, +0800 as it gives them, in order. Before
 * `PRE_660` is before #488 shipped the escape lines at all, so nothing there
 * is judged. */
const WINDOWS = /** @type {const} */ (["pre-660", "660", "671", "1061"]);
const PRE_660 = Date.parse("2026-09-27T18:46:00+08:00");
const AT_660 = Date.parse("2026-09-28T15:30:00+08:00");
/* e57bd34a, the commit that dropped the first-sight refusal (#671). */
const AT_671 = Date.parse("2026-09-28T19:15:39+08:00");
/* #1098's commit, which refuses every close question once again (#1061). */
const AT_1061 = Date.parse("2026-10-09T19:01:58+08:00");

/* Words only the close-rivals refusal prints, every text since #488 alike. */
const CLOSE_REFUSAL = /top two rivals sit close|could flip/;
/* The refusal's opening, its flagged lines the paragraph after it, one per
 * question and naming the round first; other limbs' lines in the same
 * feedback name rounds they flag, not these. */
const REFUSAL_FLAGGED = /top two rivals sit close[^\n]*\n\n((?:.+\n?)*)/;
const REFUSED_LINE = /^Q(\d+): /gm;

/* What of the trail between a refusal and its re-send reaches the judge:
 * each call's input, result and the session's text between cut to a head,
 * the whole trail to its head and tail. Chosen, not measured (#4945, #5003). */
const CALL_CHARS = 400;
const RESULT_CHARS = 4000;
const SAID_CHARS = 2000;
const TRAIL_CHARS = 40_000;

/* The two escapes a close question may carry, read like `Relation:`: a line of
 * its own, the label optionally bold, a colon, then text. The tail is captured
 * rather than matched, so `**Checked:**` with nothing after it reads as empty. */
const ESCAPE_LINE = /^\s{0,3}(?:\*\*)?(Checked|Unmeasured)(?:\*\*)?:(.*)$/i;

/**
 * A block's escape lines, each only where its tail says something, joined
 * whitespace-normalised; "" where it carries none.
 * @param {string[]} lines
 * @returns {string}
 */
function escapesIn(lines) {
	const found = [];
	for (const line of lines) {
		const m = line.match(ESCAPE_LINE);
		if (!m) continue;
		const tail = requiredGroup(m, 2, ESCAPE_LINE)
			.replace(/^\s*\*\*/, "")
			.trim();
		if (tail)
			found.push(
				`${requiredGroup(m, 1, ESCAPE_LINE).toLowerCase()}: ${tail.replace(/\s+/g, " ")}`,
			);
	}
	return found.join("\n");
}

/**
 * @typedef {{ key: string, round: string, session: string, at: string,
 *   window: (typeof WINDOWS)[number], sight: "first" | "after-refusal",
 *   escape: "checked" | "unmeasured" | "both" | "none", text: string,
 *   refusedText?: string, message?: string, calls?: string }} Item
 * `text` is the question block; on an after-refusal item, `refusedText` the
 * block as first refused, `message` the whole text the re-send went in, and
 * `calls` the tool calls and the session's text since. All four are held in
 * memory for the judge and never written to the items index.
 */

/**
 * @typedef {import("./transcript.js").TranscriptRecord} TranscriptRecord
 * @typedef {{ rivalPair: Function,
 *   splitQuestions: (text: string) => import("./round-marker.js").QuestionBlock[] }} Deps
 * @typedef {{ pending: Item[], refused: Map<string, { text: string, from: number }>,
 *   lastAsk: string, trail: string[] }} Turn
 *   `pending` holds the rounds of the latest question, committed once a send
 *   passes; `refused`, each question a close-rivals refusal named that still
 *   holds, its block as first refused and the `trail` length then;
 *   `lastAsk`, the latest text carrying a question; `trail`, the tool calls,
 *   their results and the session's text since the first refusal still
 *   holding.
 */

/**
 * @param {TranscriptRecord} rec
 * @returns {string}
 */
function textOf(rec) {
	const c = rec.message?.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c
		.filter((p) => p?.type === "text")
		.map((p) => p.text ?? "")
		.join("\n");
}

/**
 * @param {TranscriptRecord} rec
 * @returns {boolean}
 */
function isToolResult(rec) {
	const c = rec.message?.content;
	return Array.isArray(c) && c.some((p) => p?.type === "tool_result");
}

/**
 * @param {number} ms
 * @returns {Item["window"] | null}
 */
function windowOf(ms) {
	if (!(ms >= PRE_660)) return null;
	if (ms < AT_660) return WINDOWS[0];
	if (ms < AT_671) return WINDOWS[1];
	return ms >= AT_1061 ? WINDOWS[3] : WINDOWS[2];
}

/**
 * @param {string} escapes  a block's escape lines, as `escapesIn` joins them
 * @returns {Item["escape"]}
 */
function escapeKindOf(escapes) {
	const checked = /^checked:/m.test(escapes);
	const unmeasured = /^unmeasured:/m.test(escapes);
	if (checked && unmeasured) return "both";
	if (checked) return "checked";
	return unmeasured ? "unmeasured" : "none";
}

/**
 * @param {string} text
 * @param {number} max
 */
const cut = (text, max) =>
	text.length > max
		? `${text.slice(0, max)} […${text.length - max} more]`
		: text;

/**
 * @param {...string} parts
 */
const keyOf = (...parts) =>
	crypto
		.createHash("sha256")
		.update(parts.join("\n"))
		.digest("hex")
		.slice(0, 16);

/**
 * @param {string[]} trail
 * @param {number} from
 */
function trailFrom(trail, from) {
	const calls = trail.slice(from).join("\n");
	if (!calls) return "(no tool call)";
	if (calls.length <= TRAIL_CHARS) return calls;
	const half = TRAIL_CHARS / 2;
	return `${calls.slice(0, half)}\n[…${calls.length - TRAIL_CHARS} chars cut…]\n${calls.slice(-half)}`;
}

/**
 * @param {string} said  the assistant text
 * @param {{ms: number, window: Item["window"]}} at
 * @param {{session: string, deps: Deps, turn: Turn}} ctx
 * @returns {Item[]}
 */
function auditedRounds(said, at, ctx) {
	const { session, deps, turn } = ctx;
	/** @type {Item[]} */
	const items = [];
	for (const block of deps.splitQuestions(said)) {
		const prior = turn.refused.get(block.number);
		const escapes = escapesIn(block.lines);
		const text = block.lines.join("\n");
		const base = {
			round: block.number,
			session,
			at: new Date(at.ms).toISOString(),
			window: at.window,
			escape: escapeKindOf(escapes),
			text,
		};
		if (prior)
			items.push({
				...base,
				key: keyOf(session, "after-refusal", prior.text, text),
				sight: "after-refusal",
				refusedText: prior.text,
				message: said,
				calls: trailFrom(turn.trail, prior.from),
			});
		else if (escapes && deps.rivalPair(block)?.close)
			items.push({ ...base, key: keyOf(session, text), sight: "first" });
	}
	return items;
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function resultText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((p) => p?.type === "text")
		.map((p) => p.text ?? "")
		.join("\n");
}

/**
 * One tool call as the trail records it: its name and input, a Bash call's
 * command alone.
 * @param {{ name?: string, input?: Record<string, unknown> }} part
 */
function renderCall({ name = "?", input = {} }) {
	const said =
		typeof input.command === "string" ? input.command : JSON.stringify(input);
	return `→ ${name}: ${cut(said, CALL_CHARS)}`;
}

/**
 * Open a refusal for each question a close-rivals Stop feedback names that
 * the turn has not yet refused, its block read from the turn's latest ask.
 * @param {string} said the feedback
 * @param {Turn} turn accumulator: `refused` gains the newly named questions
 * @param {Deps} deps
 */
function openRefusals(said, turn, deps) {
	const opening = said.match(REFUSAL_FLAGGED);
	if (!opening) return;
	const flagged = requiredGroup(opening, 1, REFUSAL_FLAGGED);
	const blocks = deps.splitQuestions(turn.lastAsk);
	for (const m of flagged.matchAll(REFUSED_LINE)) {
		const number = requiredGroup(m, 1, REFUSED_LINE);
		if (turn.refused.has(number)) continue;
		const block = blocks.find((b) => b.number === number);
		if (block)
			turn.refused.set(number, {
				text: block.lines.join("\n"),
				from: turn.trail.length,
			});
	}
}

/** @returns {Turn} */
const newTurn = () => ({
	pending: [],
	refused: new Map(),
	lastAsk: "",
	trail: [],
});

/**
 * @param {TranscriptRecord} rec
 * @param {Turn} turn accumulator: `trail` grows
 */
function trailToolResult(rec, turn) {
	const content = rec.message?.content;
	if (turn.refused.size === 0 || !Array.isArray(content)) return;
	for (const p of content)
		if (p?.type === "tool_result")
			turn.trail.push(`← ${cut(resultText(p.content), RESULT_CHARS)}`);
}

/**
 * Commit the pending rounds as passed, retiring the refusal of each re-send
 * among them.
 * @param {TranscriptRecord} rec the user record that ended the send
 * @param {Turn} turn accumulator: the turn's state, advanced in place
 * @param {Item[]} out accumulator: each committed item is pushed here
 */
function commitPending(rec, turn, out) {
	out.push(...turn.pending);
	for (const item of turn.pending)
		if (item.sight === "after-refusal") turn.refused.delete(item.round);
	turn.pending = [];
	if (isFounderMessage(rec)) Object.assign(turn, newTurn());
	else if (turn.refused.size === 0) turn.trail = [];
}

/**
 * @param {TranscriptRecord} rec
 * @param {Turn} turn accumulator: the turn's state, advanced in place
 * @param {{out: Item[], deps: Deps}} ctx
 * @returns {void}
 */
function readUser(rec, turn, { out, deps }) {
	if (isToolResult(rec)) {
		trailToolResult(rec, turn);
		return;
	}
	const said = textOf(rec);
	if (STOP_FEEDBACK.test(said)) {
		turn.pending = [];
		if (CLOSE_REFUSAL.test(said)) openRefusals(said, turn, deps);
		return;
	}
	commitPending(rec, turn, out);
}

/**
 * @param {string} said
 * @param {Turn} turn accumulator: `trail` grows
 */
function trailSaid(said, turn) {
	if (turn.refused.size > 0 && said.trim())
		turn.trail.push(`said: ${cut(said.trim(), SAID_CHARS)}`);
}

/**
 * An assistant record: a tool call drops the pending rounds, as the turn did
 * not end there; a text carrying a question replaces them with its own. While
 * a refusal holds, the record's text joins the trail after its rounds are
 * read, so a re-send's own text reaches only a later re-send's trail.
 * @param {TranscriptRecord} rec
 * @param {Turn} turn accumulator: the turn's state, advanced in place
 * @param {{session: string, deps: Deps}} ctx
 * @returns {void}
 */
function readAssistant(rec, turn, ctx) {
	const content = rec.message?.content;
	const calls = Array.isArray(content)
		? content.filter((p) => p?.type === "tool_use")
		: [];
	const said = textOf(rec);
	if (calls.length > 0) {
		turn.pending = [];
		turn.lastAsk = "";
		trailSaid(said, turn);
		if (turn.refused.size > 0) turn.trail.push(...calls.map(renderCall));
		return;
	}
	if (said.includes("❓")) {
		turn.lastAsk = said;
		const ms = Date.parse(rec.timestamp);
		const window = windowOf(ms);
		turn.pending = window
			? auditedRounds(said, { ms, window }, { ...ctx, turn })
			: [];
	}
	trailSaid(said, turn);
}

/**
 * @param {string} text the transcript
 * @param {string} session
 * @param {Deps} deps
 * @returns {Item[]}
 */
function itemsIn(text, session, deps) {
	/** @type {Item[]} */
	const out = [];
	const turn = newTurn();
	for (const rec of mainChainRecords(text, "main")) {
		if (rec.type === "user") readUser(rec, turn, { out, deps });
		else if (rec.type === "assistant")
			readAssistant(rec, turn, { session, deps });
	}
	out.push(...turn.pending);
	return out;
}

/** @param {string} root */
const itemsPath = (root) => path.join(markersDir(root), ITEMS_NAME);
/** @param {string} root */
const verdictsPath = (root) => path.join(markersDir(root), VERDICTS_NAME);

/**
 * Replace the items index, question text stripped, atomically, with the count of
 * transcripts that would not read, so the report can say it under-counts.
 * @param {string} root
 * @param {Item[]} items
 * @param {number} [unreadable]
 */
function writeItems(root, items, unreadable = 0) {
	writeFileAtomic(
		itemsPath(root),
		JSON.stringify({
			at: new Date().toISOString(),
			unreadable,
			items: items.map(
				({ text: _t, refusedText: _r, message: _m, calls: _c, ...rest }) =>
					rest,
			),
		}),
	);
}

/** @typedef {Omit<Item, "text" | "refusedText" | "message" | "calls">} IndexedItem */

/**
 * The items index, or null where no batch has run.
 * @param {string} root
 * @returns {{ at: string, unreadable?: number, items: IndexedItem[] } | null}
 */
function readItems(root) {
	try {
		return JSON.parse(fs.readFileSync(itemsPath(root), "utf8"));
	} catch (e) {
		if (caught(e).code === "ENOENT") return null;
		throw e;
	}
}

/**
 * @typedef {{ key: string, at: string, question?: string,
 *   outcome: "bears" | "misses" | "outage" | "malformed" | "unswept" | "finding",
 *   probability?: number }} Verdict
 * `bears`/`misses` are answers; the rest are retried on a later run, bar
 * `finding`: gitleaks hit the block, so it is never sent. `question` is the
 * judge's question key the row answers.
 */

const ANSWERED = new Set(["bears", "misses", "finding"]);

/**
 * The last verdict per key.
 * @param {string} root
 * @returns {Map<string, Verdict>}
 */
function readVerdicts(root) {
	/** @type {Map<string, Verdict>} */
	const out = new Map();
	for (const v of readJsonl(verdictsPath(root))?.rows ?? [])
		if (typeof v.key === "string") out.set(v.key, /** @type {Verdict} */ (v));
	return out;
}

/**
 * @param {string} root
 * @param {Verdict} verdict
 */
function appendVerdict(root, verdict) {
	fs.appendFileSync(verdictsPath(root), `${JSON.stringify(verdict)}\n`);
}

module.exports = {
	ANSWERED,
	WINDOWS,
	appendVerdict,
	itemsIn,
	readItems,
	readVerdicts,
	verdictsPath,
	writeItems,
};
