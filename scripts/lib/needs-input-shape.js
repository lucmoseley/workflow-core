/*
 * needs-input-shape.js — the whole shape a background job's `needs input:`
 * ending owes, as one checklist (#4206).
 *
 * Three Stop hooks judge that ending — guard-inventory.js, guard-priced-options.js
 * and the user-level practice hook — and several limbs judge only once an
 * earlier piece exists, so a session told only its own defects found the shape
 * one refusal at a time. Both guards here end a refusal of that ending with
 * this checklist: every piece owed, each met, missing or not yet judged.
 *
 * IT CHANGES WHAT A REFUSAL SAYS, NEVER WHETHER ONE IS SENT. A piece's state is
 * what the calling guard judged, or what reading the message alone shows
 * missing; it charges no counter.
 *
 * WHICH PARK (`parkKind`) is owned here too, so the checklist and
 * guard-priced-options.js's no-round limb read it the one way: a round; a lone
 * founder hand-over (#926); a pointer at a round still standing (#924); a park
 * on an open repo hold (#3858); or prose, which owes the round it lacks.
 *
 * ONCE A TURN (`shareChecklist`): the two guards run side by side at Stop, so
 * the first to claim the turn's marker prints the checklist and the other
 * refers to it. Residual: a guard that claims and then fails to write its block
 * leaves the other's reference pointing at nothing.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { failOpenLogger } = require("./fail-open-logger");
const { HAND_OFF_SHAPE } = require("./hand-off");
const { INVENTORY } = require("./inventory-format");
const { markersDir } = require("./marker-root.js");
const { requiredGroup } = require("./regex-group");
const { splitQuestions } = require("./round-marker");
const { scriptPath } = require("./script-path");
const { governingMarker } = require("./status-marker");

/* A pasteable `!` command's opening, which every pattern reading one is built
 * from (#936); `![` opens a Markdown image, not a command. */
const BANG = /!\s*[^\s`[]/.source;
const HANDOVER_BANG = new RegExp(String.raw`^\s{0,3}\x60?${BANG}`);
const FENCE = /^\s{0,3}```/;
/* An `(A)`-style letter anywhere, which voids the hand-over and hold parks. */
const NAMES_A_LETTER = /\([A-Z]\)/;
/* What `rule:founder-handover`'s third step asks for — what to send back, or
 * what the session then checks (#926). Lexical, so a send-back phrased
 * otherwise is refused and the session rewords it. The 30- and 40-character
 * reaches are chosen, not measured. */
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
 * Whether a message ends in a founder hand-over: at least one literal act — a
 * `!` line, or a fenced block of literal text — with a send-back line after
 * the last of them. Lines inside a fence are never read as the send-back.
 *
 * TWO RESIDUALS. Any fenced block counts as an act, so quoted output followed
 * by "let me know" passes. And nothing bounds the prose between the last act
 * and the send-back, so a decision put in unlettered prose there passes too —
 * `parkKind` voids the exemption on a letter, never on prose.
 *
 * @param {string} message the outgoing assistant message
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

/* The fail-open log's second field for the standing-round reader (#924),
 * which fails closed. */
const FAIL_LOG_STANDING = "guard-priced-options standing-round";
/* A round named by number on the marker's own line: `Q1 above`. */
const NAMED_ROUND = /\bQ(\d+)\b/g;

/**
 * Whether a `needs input:` payload points at rounds still standing (#924):
 * it names at least one `Q<n>`, and every one it names was opened in the
 * assistant's text since the founder last spoke, in a turn no Stop hook sent
 * back (`lib/tool-calls-since.js`).
 *
 * IT FAILS CLOSED, LOGGED. A missed pointer costs a re-printed round; a
 * pointer let through wrongly ends the job on a round the founder already
 * answered or never saw.
 *
 * RESIDUAL: a `❓ **Qn**` line quoted in an earlier message, fenced or not,
 * counts as posted.
 *
 * @param {string} payload the governing marker's text after its colon
 * @param {string} [transcript] the session's transcript path
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

/* The fail-open log's second field for the attached-park reader (#3858). */
const FAIL_LOG_ATTACHED = "guard-priced-options attached-park";

/**
 * Whether a `needs input:` payload parks this job on an open repo hold it is
 * attached to (#3858). Fails closed, logged, on `pointsAtStandingRound`'s terms:
 * a missed park costs a round the founder may already hold; a park let through
 * wrongly ends the job with its question asked nowhere.
 * @param {string} payload the governing marker's text after its colon
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
 * Which park a `needs input:` ending is: one carrying a round, or one of the
 * three that owe none, or prose, which owes the round it lacks.
 * @param {string} message
 * @param {string} payload the `needs input:` marker's text after its colon
 * @param {string} [transcript] the session's transcript path
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
 * Each piece's own words, and what a piece no caller judged waits on.
 * @type {Record<PieceId, { how: (kind: ParkKind) => string, judgedBy: string }>}
 */
const PIECES = {
	research: {
		how: () =>
			"research before the round: past rulings, then web or vendor docs, then a fresh subagent, each a tool call, wherever the top two options sit close or the top is priced 65% or less; and the round sent no sooner than 10 tool calls after the founder's last message",
		judgedBy: PRICED_GUARD,
	},
	round: {
		how: () =>
			"a `❓ **Qn**` round: a `Relation:` line, then each option `(A) <option>` on its own line with its own `Confidence: 70% (60% - 80%). <what drives it>` line, then one recommendation",
		judgedBy: PRICED_GUARD,
	},
	act: {
		how: () =>
			"the founder's one act, as its literal `!` line or fenced text, then what to send back (#926)",
		judgedBy: PRICED_GUARD,
	},
	pointer: {
		how: () =>
			`the status line names \`Qn\` of a round still standing from an earlier turn: \`needs input: Q1 above — <the decision> ${INVENTORY.refsTail}\` (#924)`,
		judgedBy: PRICED_GUARD,
	},
	hold: {
		how: () =>
			"the status line names `hold <id>` and that hold's `#<issue>`, a hold this job is attached to (#3858)",
		judgedBy: PRICED_GUARD,
	},
	posted: {
		how: () =>
			"the round posted as a comment on the open issue that carries the decision, among its newest five comments",
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

/** @type {Record<ParkKind, PieceId[]>} the pieces each park owes, in writing order */
const OWED = {
	round: [
		"research",
		"round",
		"posted",
		"claimed",
		"hand-off",
		"block",
		"status",
		"practice",
	],
	prose: [
		"research",
		"round",
		"posted",
		"claimed",
		"hand-off",
		"block",
		"status",
		"practice",
	],
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

/* A block line naming an item heading, before the status line. */
const BLOCK_HEADER = /^[ \t]*waits on you:/m;
/* The status line's issue tail. */
const REFS_TAIL = /[—–-][ \t]*waits on you:[ \t]*\S/i;

/**
 * What the message alone shows missing — never met, which only a guard judges.
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

/* The pieces read on the tracker, each gated on an earlier one. */
const TRACKED = new Set(["posted", "claimed", "hand-off"]);

/**
 * What a piece no caller judged waits on, where an earlier piece gates it.
 * @param {PieceId} id
 * @param {ParkKind} kind
 * @param {(id: PieceId) => Judged | undefined} stateOf
 * @returns {string|undefined}
 */
function gate(id, kind, stateOf) {
	if (kind === "prose" && (id === "research" || TRACKED.has(id)))
		return ONCE_ROUND;
	if (!TRACKED.has(id)) return;
	if (id === "posted" || kind !== "round")
		return stateOf("block") === "missing" ? ONCE_BLOCK : undefined;
	return stateOf("posted") === "met" ? undefined : ONCE_POSTED;
}

/**
 * Every piece this park owes, in writing order, each met, missing or not yet
 * judged. A guard's judgement wins over the message's own gaps save where the
 * message shows a piece missing.
 * @param {string} message
 * @param {ParkKind} kind
 * @param {Judgement} [judged] what the calling guard judged this turn
 * @returns {Piece[]}
 */
function owedPieces(message, kind, judged = {}) {
	const gaps = lexicalGaps(message, kind);
	/** @param {PieceId} id */
	const stateOf = (id) => gaps[id] ?? judged[id];
	return OWED[kind].map((id) => {
		const piece = PIECES[id];
		const how = piece.how(kind);
		/* `parkKind` read the hand-over, pointer and hold whole. */
		const state =
			stateOf(id) ??
			(["act", "pointer", "hold"].includes(id) ? "met" : undefined);
		if (state) return { id, state, how };
		return {
			id,
			state: "unjudged",
			waitsOn: gate(id, kind, stateOf) ?? piece.judgedBy,
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
	return `EVERY PIECE THIS \`needs input:\` ENDING OWES (#4206) — ${KIND_WORDS[kind]}. Write each one not met, in this order, then end once:\n\n${lines.join("\n")}`;
}

const CLAIM_PREFIX = ".needs-input-checklist-";
/* How long a turn's claim stands. Both guards run side by side within a
 * second or two at one Stop; a later Stop on the same message is a re-send,
 * which claims afresh. A first guess, well clear of the hooks' own runtime. */
const CLAIM_FRESH_MS = 30_000;
const REFERENCE =
	"The checklist of every piece this `needs input:` ending owes sits in the other Stop refusal this turn (#4206).";

/**
 * Whether this guard prints the turn's checklist: the first of the two to
 * claim the turn's marker does. Its name holds the session id and the
 * message's hash, so the marker sweep ages it out. An unwritable marker prints
 * it, a repeat costing less than none.
 * @param {string} sessionId
 * @param {string} message
 * @param {number} [now]
 * @returns {boolean}
 */
function claimTurn(sessionId, message, now = Date.now()) {
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
			return /** @type {NodeJS.ErrnoException} */ (e).code !== "EEXIST";
		}
	};
	if (create()) return true;
	try {
		if (now - fs.statSync(file).mtimeMs <= CLAIM_FRESH_MS) return false;
		/* Stale: one rename succeeds, so one of two racing re-sends re-creates. */
		const aside = `${file}.${String(process.pid)}`;
		fs.renameSync(file, aside);
		fs.rmSync(aside, { force: true });
	} catch {
		/* Another guard moved it first; its create, or ours, wins below. */
	}
	return create();
}

/**
 * The checklist for a refused `needs input:` ending, or a pointer to the other
 * guard's copy where that guard claimed this turn first.
 * @param {{ sessionId: string, message: string, kind: ParkKind,
 *   judged?: Judgement }} turn
 * @returns {string}
 */
function shareChecklist({ sessionId, message, kind, judged }) {
	return claimTurn(sessionId, message)
		? renderChecklist(owedPieces(message, kind, judged), kind)
		: REFERENCE;
}

module.exports = {
	BANG,
	CLAIM_PREFIX,
	NAMES_A_LETTER,
	isFounderHandover,
	owedPieces,
	parkKind,
	renderChecklist,
	shareChecklist,
};
