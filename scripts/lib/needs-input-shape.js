const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { caught, orFallback } = require("./caught");
const { failOpenLogger } = require("./fail-open-logger");
const { HAND_OFF_SHAPE } = require("./hand-off");
const { INVENTORY } = require("./inventory-format");
const { markersDir } = require("./marker-root.js");
const { COMMENTS_READ } = require("./outstanding-line");
const { requiredGroup } = require("./regex-group");
const { splitQuestions } = require("./round-marker");
const { scriptPath } = require("./script-path");
const { governingMarker } = require("./status-marker");

const BANG = /!\s*[^\s`[]/.source;
const HANDOVER_BANG = new RegExp(String.raw`^\s{0,3}\x60?${BANG}`);
const FENCE = /^\s{0,3}```/;
const NAMES_A_LETTER = /\([A-Z]\)/;
// guess: the 30- and 40-character reaches, workflow-core#926
const SEND_BACK = new RegExp(
	[
		String.raw`\b(?:send|paste)\b[^.\n]{0,30}\bback\b`,
		String.raw`\b(?:reply|tell me|let me know)\b`,
		String.raw`\bonce (?:it|that|the \w+) (?:prints|shows|lands|returns|finishes)\b`,
		String.raw`\b(?:I['’]ll|I will|I then|then I)\b[^.\n]{0,40}?\b(?:check|verify|confirm|read|re-?run|finish|commit|close)\b`,
	].join("|"),
	"i",
);

/**
 * @param {string} message
 * @returns {boolean}
 */
function isFounderHandover(message) {
	let inFence = false;
	let lastAct = -1;
	let lastSendBack = -1;
	const lines = String(message).split("\n");
	for (const [at, line] of lines.entries()) {
		if (FENCE.test(line)) {
			if (inFence) lastAct = at;
			inFence = !inFence;
		} else if (inFence) continue;
		else if (HANDOVER_BANG.test(line)) lastAct = at;
		else if (SEND_BACK.test(line)) lastSendBack = at;
	}
	return lastAct >= 0 && lastSendBack > lastAct;
}

const FAIL_LOG_STANDING = "needs-input-shape standing-round";
const NAMED_ROUND = /\bQ(\d+)\b/g;

/**
 * @param {string} payload
 * @param {string} [transcript]
 * @returns {boolean}
 */
function pointsAtStandingRound(payload, transcript) {
	const named = [...payload.matchAll(NAMED_ROUND)].map((m) =>
		requiredGroup(m, 1, NAMED_ROUND),
	);
	if (named.length === 0 || !transcript) return false;
	const log = failOpenLogger(FAIL_LOG_STANDING);
	let rounds;
	try {
		rounds = require("./tool-calls-since").standingRounds(transcript);
	} catch (e) {
		log?.(`transcript would not be read at ${transcript}: ${e} — refused`);
		return false;
	}
	if (rounds === null) {
		log?.(`transcript parsed to no records at ${transcript} — refused`);
		return false;
	}
	return named.every((n) => rounds.includes(n));
}

const FAIL_LOG_ATTACHED = "needs-input-shape attached-park";

/**
 * @param {string} payload
 * @returns {boolean}
 */
function isAttachedPark(payload) {
	try {
		return require("./repo-holds").findOwnHold(payload) !== null;
	} catch (e) {
		failOpenLogger(FAIL_LOG_ATTACHED)?.(`holds would not read: ${e} — refused`);
		return false;
	}
}

/** @typedef {"round" | "handover" | "pointer" | "hold" | "prose"} ParkKind */

/**
 * @param {string} message
 * @param {string} payload
 * @param {string} [transcript]
 * @returns {ParkKind}
 */
function parkKind(message, payload, transcript) {
	if (splitQuestions(message).length > 0) return "round";
	const lettered = NAMES_A_LETTER.test(message);
	if (!lettered && isFounderHandover(message)) return "handover";
	if (pointsAtStandingRound(payload, transcript)) return "pointer";
	if (!lettered && isAttachedPark(payload)) return "hold";
	return "prose";
}

/** @typedef {"met" | "missing"} Judged */
/** @typedef {Partial<Record<PieceId, Judged>>} Judgement */
/**
 * @typedef {"research" | "round" | "act" | "pointer" | "hold" | "posted" |
 *   "claimed" | "hand-off" | "block" | "status" | "practice"} PieceId
 */
/**
 * @typedef {{ id: PieceId, state: "met" | "missing" | "unjudged",
 *   waitsOn?: string, how: string }} Piece
 */

const INVENTORY_GUARD = "guard-inventory.js judges it, reading the tracker";
const PRICED_GUARD = "guard-priced-options.js judges it";
const ONCE_ROUND = "once the round is written";
const ONCE_POSTED = "once the round is posted on that issue";
const ONCE_BLOCK = "once the `waits on you:` block cites the open issue";

/**
 * @type {Record<PieceId, { how: (kind: ParkKind) => string, judgedBy: string }>}
 */
const PIECES = {
	research: {
		how: () =>
			`research before the round: past rulings, then web or vendor docs, then a fresh subagent, each a tool call, wherever the top two options sit close or the top is priced ${String(require("./close-rivals").LOW_TOP)}% or less; and the round sent no sooner than ${String(require("./round-check").MIN_CALLS)} tool calls after the founder's last message`,
		judgedBy: PRICED_GUARD,
	},
	round: {
		how: () =>
			"a `❓ **Qn**` round: a `Relation:` line, then each option `(A) <option>` on its own line with its own `Confidence: 70% (60% - 80%). <what drives it>` line, then one recommendation",
		judgedBy: PRICED_GUARD,
	},
	act: {
		how: () =>
			"the founder's one act, as its literal `!` line or fenced text, then what to send back (workflow-core#926)",
		judgedBy: PRICED_GUARD,
	},
	pointer: {
		how: () =>
			`the status line names \`Qn\` of a round still standing from an earlier turn: \`needs input: Q1 above — <the decision> ${INVENTORY.refsTail}\` (workflow-core#924)`,
		judgedBy: PRICED_GUARD,
	},
	hold: {
		how: () =>
			"the status line names `hold <id>` and that hold's `#<issue>`, a hold this job is attached to (workflow-core#3858)",
		judgedBy: PRICED_GUARD,
	},
	posted: {
		how: () =>
			`the round posted as a comment on the open issue that carries the decision, among its newest ${String(COMMENTS_READ)} comments`,
		judgedBy: INVENTORY_GUARD,
	},
	claimed: {
		how: () =>
			`this session's claim on that issue: \`node ${scriptPath("claim-issue.js")} <n>\``,
		judgedBy: INVENTORY_GUARD,
	},
	"hand-off": {
		how: (kind) =>
			`${kind === "round" || kind === "prose" ? "in the round's comment" : "in the newest comment on a cited issue, its `Blocked on:` naming what the park waits on"}, a \`**Hand-off:**\` block posted since this session started or last resumed, with no file this session wrote left uncommitted:\n\n${HAND_OFF_SHAPE}`,
		judgedBy: INVENTORY_GUARD,
	},
	block: {
		how: (kind) =>
			`the plain line \`waits on you:\` ${INVENTORY.placement}, then ${INVENTORY.itemLines}, each an open issue${kind === "round" || kind === "prose" ? ": `- #N (answer Q1, round posted on the issue)`" : ""}`,
		judgedBy: INVENTORY_GUARD,
	},
	status: {
		how: () =>
			`the status line last, nothing below it and nothing promised after it, naming the decision and listing the block's issues: \`${INVENTORY.needsInputLine}\``,
		judgedBy: "guard-inventory.js and guard-priced-options.js judge it",
	},
	practice: {
		how: () =>
			"where this session wrote a tracked file, one `**Practice:**` line in the reply or the close comment: `ran — <note>`, `covered — <note>, <Researched date>`, `skipped — <exempt kind>` or `none-fits — nearest <craft>`",
		judgedBy: "the practice Stop hook outside this repo judges it",
	},
};

/** @type {PieceId[]} */
const ROUND_PIECES = [
	"research",
	"round",
	"posted",
	"claimed",
	"hand-off",
	"block",
	"status",
	"practice",
];
/** @type {Record<ParkKind, PieceId[]>} */
const OWED = {
	round: ROUND_PIECES,
	prose: ROUND_PIECES,
	handover: ["act", "hand-off", "block", "status", "practice"],
	pointer: ["pointer", "hand-off", "block", "status", "practice"],
	hold: ["hold", "claimed", "hand-off", "block", "status", "practice"],
};

/** @type {Record<ParkKind, string>} */
const KIND_WORDS = {
	round: "a park asking a round",
	prose: "a park asking a decision in prose, which owes a round",
	handover: "a founder hand-over, which owes no round",
	pointer: "a pointer at a standing round, which owes no new one",
	hold: "a park on a repo hold, which owes no round",
};

const BLOCK_HEADER = /^[ \t]*waits on you:/m;
const REFS_TAIL = /[—–-][ \t]*waits on you:[ \t]*\S/i;

/**
 * @param {string} message
 * @param {ParkKind} kind
 * @returns {Judgement}
 */
function lexicalGaps(message, kind) {
	const marker = governingMarker(message);
	/** @type {Judgement} */
	const gaps = {};
	if (kind === "prose") gaps.round = "missing";
	if (!BLOCK_HEADER.test(message.slice(0, Math.max(marker.at, 0))))
		gaps.block = "missing";
	if (!marker.payload.trim() || !REFS_TAIL.test(marker.payload))
		gaps.status = "missing";
	return gaps;
}

const TRACKED = new Set(["posted", "claimed", "hand-off"]);

/**
 * @param {PieceId} id
 * @param {ParkKind} kind
 * @param {(id: PieceId) => Judged | undefined} stateOf
 * @returns {string|undefined}
 */
function waitsOnOf(id, kind, stateOf) {
	if (kind === "prose" && (id === "research" || TRACKED.has(id)))
		return ONCE_ROUND;
	if (!TRACKED.has(id)) return;
	if (id === "posted" || kind !== "round")
		return stateOf("block") === "missing" ? ONCE_BLOCK : undefined;
	return stateOf("posted") === "met" ? undefined : ONCE_POSTED;
}

/**
 * @param {string} message
 * @param {ParkKind} kind
 * @param {Judgement} [judged]
 * @returns {Piece[]}
 */
function owedPieces(message, kind, judged = {}) {
	const gaps = lexicalGaps(message, kind);
	/** @param {PieceId} id */
	const stateOf = (id) => gaps[id] ?? judged[id];
	return OWED[kind].map((id) => {
		const piece = PIECES[id];
		const how = piece.how(kind);
		const state =
			stateOf(id) ??
			(["act", "pointer", "hold"].includes(id) ? "met" : undefined);
		if (state) return { id, state, how };
		return {
			id,
			state: "unjudged",
			waitsOn: waitsOnOf(id, kind, stateOf) ?? piece.judgedBy,
			how,
		};
	});
}

/**
 * @param {Piece[]} pieces
 * @param {ParkKind} kind
 * @returns {string}
 */
function renderChecklist(pieces, kind) {
	const lines = pieces.map((p, i) => {
		const n = `${String(i + 1)}. **${p.id}**`;
		if (p.state === "met") return `${n} — met.`;
		if (p.state === "missing") return `${n} — MISSING: ${p.how}`;
		return `${n} — not yet judged (${p.waitsOn}): ${p.how}`;
	});
	return `EVERY PIECE THIS \`needs input:\` ENDING OWES (workflow-core#4206) — ${KIND_WORDS[kind]}. Write each one not met, in this order, then end once:\n\n${lines.join("\n")}`;
}

const CLAIM_PREFIX = ".needs-input-checklist-";
// guess, workflow-core#4206
const CLAIM_FRESH_MS = 30_000;
const REFERENCE =
	"The checklist of every piece this `needs input:` ending owes sits in the other Stop refusal this turn (workflow-core#4206).";

/**
 * @param {string} sessionId
 * @param {string} message
 * @returns {boolean}
 */
function claimTurn(sessionId, message) {
	const hash = crypto.createHash("sha256").update(message).digest("hex");
	let file;
	try {
		file = path.join(
			markersDir(),
			`${CLAIM_PREFIX}${sessionId}-${hash.slice(0, 16)}`,
		);
	} catch {
		return true;
	}
	const create = () => {
		try {
			fs.writeFileSync(file, "", { flag: "wx" });
			return true;
		} catch (e) {
			return caught(e).code !== "EEXIST";
		}
	};
	if (create()) return true;
	const fresh = orFallback(() => {
		if (Date.now() - fs.statSync(file).mtimeMs <= CLAIM_FRESH_MS) return true;
		const aside = `${file}.${String(process.pid)}`;
		fs.renameSync(file, aside);
		fs.rmSync(aside, { force: true });
		return false;
	}, false);
	return fresh ? false : create();
}

/**
 * @param {{ sessionId: string, message: string, payload: string,
 *   transcript?: string, judged?: Judgement }} turn
 * @returns {string}
 */
function shareChecklist({ sessionId, message, payload, transcript, judged }) {
	if (!claimTurn(sessionId, message)) return `\n\n${REFERENCE}`;
	const kind = parkKind(message, payload, transcript);
	return `\n\n${renderChecklist(owedPieces(message, kind, judged), kind)}`;
}

module.exports = {
	BANG,
	NAMES_A_LETTER,
	parkKind,
	shareChecklist,
};
