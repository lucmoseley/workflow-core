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

const WINDOWS = /** @type {const} */ (["pre-660", "660", "671", "1061"]);
const PRE_660 = Date.parse("2026-09-27T18:46:00+08:00");
const AT_660 = Date.parse("2026-09-28T15:30:00+08:00");
const AT_671 = Date.parse("2026-09-28T19:15:39+08:00");
const AT_1061 = Date.parse("2026-10-09T19:01:58+08:00");

const CLOSE_REFUSAL = /top two rivals sit close|could flip/;
const REFUSAL_FLAGGED = /top two rivals sit close[^\n]*\n\n((?:.+\n?)*)/;
const REFUSED_LINE = /^Q(\d+): /gm;

// guess, #4945
const CALL_CHARS = 400;
const RESULT_CHARS = 4000;
const SAID_CHARS = 2000;
const TRAIL_CHARS = 40_000;

const ESCAPE_LINE = /^\s{0,3}(?:\*\*)?(Checked|Unmeasured)(?:\*\*)?:(.*)$/i;

/**
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
 */

/**
 * @typedef {import("./transcript.js").TranscriptRecord} TranscriptRecord
 * @typedef {{ rivalPair: Function,
 *   splitQuestions: (text: string) => import("./round-marker.js").QuestionBlock[] }} Deps
 * @typedef {{ pending: Item[], refused: Map<string, { text: string, from: number }>,
 *   lastAsk: string, trail: string[] }} Turn
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
 * @param {string} escapes
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
 * @param {string} said
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

/** @param {{ name?: string, input?: Record<string, unknown> }} part */
function renderCall({ name = "?", input = {} }) {
	const said =
		typeof input.command === "string" ? input.command : JSON.stringify(input);
	return `→ ${name}: ${cut(said, CALL_CHARS)}`;
}

/**
 * @param {string} said
 * @param {Turn} turn
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
 * @param {Turn} turn
 */
function trailToolResult(rec, turn) {
	const content = rec.message?.content;
	if (turn.refused.size === 0 || !Array.isArray(content)) return;
	for (const p of content)
		if (p?.type === "tool_result")
			turn.trail.push(`← ${cut(resultText(p.content), RESULT_CHARS)}`);
}

/**
 * @param {TranscriptRecord} rec
 * @param {Turn} turn
 * @param {Item[]} out
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
 * @param {Turn} turn
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
 * @param {Turn} turn
 */
function trailSaid(said, turn) {
	if (turn.refused.size > 0 && said.trim())
		turn.trail.push(`said: ${cut(said.trim(), SAID_CHARS)}`);
}

/**
 * @param {TranscriptRecord} rec
 * @param {Turn} turn
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
 * @param {string} text
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
 */

const ANSWERED = new Set(["bears", "misses", "finding"]);

/**
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
