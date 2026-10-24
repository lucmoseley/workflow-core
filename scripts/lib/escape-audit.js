/*
 * escape-audit.js — the escape-line audit's reading half (workflow-core#671 step 3): which
 * close-rivals rounds got past `guard-priced-options.js` on a `Checked:` or
 * `Unmeasured:` line, and what the judge made of each.
 *
 * `audit-escape-lines.js` owns the judging and the report; this file owns the
 * extraction and the two stores.
 *
 * WHAT COUNTS AS GETTING PAST. A `❓ **Qn**` block in an assistant text record
 * whose top two rivals are close (`rivalPair`) and which carries a non-empty
 * escape line, where the next user record that is not a tool result is not a
 * Stop hook's feedback. A text record followed by a tool call before any such
 * user record was not the turn's last message, so the Stop guard never read
 * it, and it is dropped. RESIDUAL: a transcript cut off mid-turn commits its
 * last text as passed.
 *
 * FIRST SIGHT OR AFTER REFUSAL. After refusal where an earlier Stop feedback
 * in the same turn carried the close-rivals refusal's own words. A turn is
 * what lies between two user records that are neither a tool result nor Stop
 * feedback — a task notification opens one too.
 *
 * THE STORES live in the markers directory under a prefix no sweep family
 * claims, so they outlive the 24 h marker sweep: the items index (rewritten
 * whole by each batch run, carrying no escape-line text) and the verdict log
 * (append-only JSONL, the last line per key winning).
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./atomic-write.js");
const { markersDir } = require("./marker-root.js");
const { STOP_FEEDBACK, mainChainRecords } = require("./transcript");
const { requiredGroup } = require("./regex-group.js");
const { caught } = require("./caught.js");

const ITEMS_NAME = ".escape-audit-items.json";
const VERDICTS_NAME = ".escape-audit-verdicts.jsonl";

/* The windows the ticket names, +0800 as it gives them, in order. Before
 * `PRE_660` is before workflow-core#488 shipped the escape lines at all, so nothing there
 * is judged. */
const WINDOWS = /** @type {const} */ (["pre-660", "660", "671", "1061"]);
const PRE_660 = Date.parse("2026-09-27T18:46:00+08:00");
const AT_660 = Date.parse("2026-09-28T15:30:00+08:00");
/* e57bd34a, the commit that dropped the first-sight refusal (workflow-core#671). */
const AT_671 = Date.parse("2026-09-28T19:15:39+08:00");
/* workflow-core#1098's commit, which refuses every close question once again (workflow-core#1061). */
const AT_1061 = Date.parse("2026-10-09T19:01:58+08:00");

/* Words only the close-rivals refusal prints, every text since workflow-core#488 alike. */
const CLOSE_REFUSAL = /top two rivals sit close|could flip/;

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
 * @typedef {{ key: string, session: string, at: string,
 *   window: (typeof WINDOWS)[number], sight: "first" | "after-refusal",
 *   escape: "checked" | "unmeasured" | "both", text: string }} Item
 * `text` is the question block, held in memory for the judge and never
 * written to the items index.
 */

/**
 * @typedef {Record<string, any>} LogRecord One parsed transcript line. `any`
 *   because JSON.parse types nothing and each field is guarded where it is read.
 * @typedef {{ rivalPair: Function, splitQuestions: Function }} Deps
 * @typedef {{ pending: Item[], refused: boolean }} Turn
 *   `pending` holds the rounds of the turn's latest question, committed once a
 *   new turn opens; `refused` is whether Stop feedback in the turn carried the
 *   close-rivals refusal.
 */

/**
 * @param {LogRecord} rec
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
 * @param {LogRecord} rec
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
	return checked ? "checked" : "unmeasured";
}

/**
 * Each close round in one assistant text that carries an escape line.
 * @param {string} said  the assistant text
 * @param {{ms: number, window: Item["window"], sight: Item["sight"]}} at
 * @param {{session: string, deps: Deps}} ctx
 * @returns {Item[]}
 */
function escapedRounds(said, at, ctx) {
	const { session, deps } = ctx;
	/** @type {Item[]} */
	const items = [];
	for (const block of deps.splitQuestions(said)) {
		if (!deps.rivalPair(block)?.close) continue;
		const escapes = escapesIn(block.lines);
		if (!escapes) continue;
		const blockText = block.lines.join("\n");
		items.push({
			key: crypto
				.createHash("sha256")
				.update(`${session}\n${blockText}`)
				.digest("hex")
				.slice(0, 16),
			session,
			at: new Date(at.ms).toISOString(),
			window: at.window,
			sight: at.sight,
			escape: escapeKindOf(escapes),
			text: blockText,
		});
	}
	return items;
}

/**
 * A user record: Stop feedback drops the turn's pending rounds and may mark
 * the turn refused; any other record that is not a tool result commits them
 * to `out` and opens a new turn.
 * @param {LogRecord} rec
 * @param {Turn} turn accumulator: the turn's state, advanced in place
 * @param {Item[]} out accumulator: each committed item is pushed here
 * @returns {void}
 */
function readUser(rec, turn, out) {
	if (isToolResult(rec)) return;
	const said = textOf(rec);
	if (STOP_FEEDBACK.test(said)) {
		turn.pending = [];
		if (CLOSE_REFUSAL.test(said)) turn.refused = true;
		return;
	}
	out.push(...turn.pending);
	turn.pending = [];
	turn.refused = false;
}

/**
 * An assistant record: a tool call drops the pending rounds, as the turn did
 * not end there; a text carrying a question replaces them with its own.
 * @param {LogRecord} rec
 * @param {Turn} turn accumulator: the turn's state, advanced in place
 * @param {{session: string, deps: Deps}} ctx
 * @returns {void}
 */
function readAssistant(rec, turn, ctx) {
	const content = rec.message?.content;
	if (Array.isArray(content) && content.some((p) => p?.type === "tool_use")) {
		turn.pending = [];
		return;
	}
	const said = textOf(rec);
	if (!said.includes("❓")) return;
	const ms = Date.parse(rec.timestamp);
	const window = windowOf(ms);
	turn.pending = window
		? escapedRounds(
				said,
				{ ms, window, sight: turn.refused ? "after-refusal" : "first" },
				ctx,
			)
		: [];
}

/**
 * Every close round that got past the guard on an escape line, in one
 * transcript.
 * @param {string} text the transcript
 * @param {string} session
 * @param {Deps} deps
 * @returns {Item[]}
 */
function itemsIn(text, session, deps) {
	/** @type {Item[]} */
	const out = [];
	/** @type {Turn} */
	const turn = { pending: [], refused: false };
	for (const rec of mainChainRecords(text, "main")) {
		if (rec.type === "user") readUser(rec, turn, out);
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
 * Replace the items index, text stripped, atomically, with the count of
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
			items: items.map(({ text: _text, ...rest }) => rest),
		}),
	);
}

/**
 * The items index, or null where no batch has run.
 * @param {string} root
 * @returns {{ at: string, unreadable?: number, items: Omit<Item, "text">[] } | null}
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
 * @typedef {{ key: string, at: string,
 *   outcome: "bears" | "misses" | "outage" | "malformed" | "unswept" | "finding",
 *   probability?: number }} Verdict
 * `bears`/`misses` are answers; the rest are retried on a later run, bar
 * `finding`: gitleaks hit the block, so it is never sent.
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
	let raw;
	try {
		raw = fs.readFileSync(verdictsPath(root), "utf8");
	} catch (e) {
		if (caught(e).code === "ENOENT") return out;
		throw e;
	}
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const v = JSON.parse(line);
			if (typeof v?.key === "string") out.set(v.key, v);
		} catch {
			/* a torn tail; the key is retried */
		}
	}
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
