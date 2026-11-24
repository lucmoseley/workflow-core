#!/usr/bin/env node
const fs = require("node:fs");
const { ignoreFailure } = require("./lib/caught.js");
const hookBlock = require("./lib/hook-block");
const { readMessageText } = require("./lib/hook-message");
const {
	buildCompactionSentence,
	COMPACTION_BACKSTOP,
	recordCompactions,
} = require("./lib/compaction-set");
const { EXITS } = require("./lib/held-unit");
const { blockedRecordOf } = require("./lib/parked");
const { scriptPath } = require("./lib/script-path");
const {
	isTripwireSpent,
	TRIPWIRE,
	TRIPWIRE_PREFIX,
} = require("./lib/session-tripwire");
const sessionTranscript = require("./lib/session-transcript");
const { INVENTORY } = require("./lib/inventory-format");
const { readPendingTasks } = require("./lib/pending-tasks");
const { governingMarker } = require("./lib/status-marker");
const stopGuard = require("./lib/stop-guard");
const {
	autocompactions,
	countTurns,
	isSubagentTranscript,
	lastStandingContext,
} = require("./lib/transcript");

/**
 * @typedef {{session_id?: string, hook_event_name?: string,
 *   transcript_path?: string, stop_hook_active?: unknown,
 *   last_assistant_message?: string}} Payload
 */

// guess, lucmoseley/mantahostels#1094
const WIND_UP = 200_000;
// lucmoseley/mantahostels#2627 measured crossing response median 99 over 990 sessions
const TURN_BAND = 100;
// lucmoseley/mantahostels#2619 measured compliance flat past block 3
const TURN_BAND_MAX_BLOCKS = 3;

// workflow-core#958
const INVENTORY_STEP = `Before you end, take the inventory. Look over everything this session produced or named, and find each founder-facing item: (1) a deliverable the founder must still act on, such as a draft to send or a file to upload; (2) an act only he can do that is written only in chat or inside a comment, such as a check by eye; (3) a decision he has not answered, whose round you post on the issue that carries it. Each one must sit in an open issue: name the issue that carries it, or file one now. Chat, the status line and a closed issue's comment never count. Then end with the inventory ${INVENTORY.placement}: \`waits on you:\`, then ${INVENTORY.itemLines}, or ${INVENTORY.nothingLine}. In a background job, also end the status line with ${INVENTORY.statusTail}.`;

/** @returns {string} */
function jobHoldsTurn() {
	return require("./lib/rule-text").readRuleTextOr(
		"job-holds-turn",
		"A background job never ends its turn on `waiting:`: it holds the turn " +
			"until what it launched reports, waiting in the foreground only once " +
			"no other work is left",
		"guard-session-ceiling waiting",
	);
}

/**
 * @param {import("./lib/pending-tasks").Launch[]} pending
 */
function closingSteps(pending) {
	if (pending.length === 0) return INVENTORY_STEP;
	return [
		"Your own background work is still out, and it belongs to the unit in flight, so the unit is not finished until it reports:",
		...pending.map(
			(l) =>
				`- ${l.name ? `${l.name} (${l.kind}, ${l.id})` : `${l.kind} ${l.id}`}`,
		),
		"Wait for it: outside a background job end this turn on `waiting:`; in one, hold the turn as below. Read each result as it lands and act on it. End on `result:` only when nothing is still out. Stop a watcher whose subject has already reported.",
		jobHoldsTurn(),
		"",
		INVENTORY_STEP,
	].join("\n");
}

/** @param {number} v */
const n = (v) => v.toLocaleString("en-GB");

/**
 * @param {boolean} firstBlock
 */
function readFounderDeliverableRule(firstBlock) {
	// workflow-core#1249
	const fd = require("./lib/founder-deliverable");
	return firstBlock
		? fd.readDeliverableRule("guard-session-ceiling")
		: fd.deliverablePointer();
}

/**
 * @param {number} tokens
 * @param {number} turns
 * @param {{tripwire: boolean, windUp: boolean, turns: boolean}} firstBlock
 * @param {string} closing
 * @returns {{band: "tripwire" | "wind-up" | "turns", reason: string} | null}
 */
function bandFor(tokens, turns, firstBlock, closing) {
	if (tokens >= TRIPWIRE && firstBlock.tripwire)
		return { band: "tripwire", reason: buildTripwireReason(tokens, closing) };
	if (tokens >= WIND_UP)
		return {
			band: "wind-up",
			reason: [
				`Standing context is ${n(tokens)} tokens — past the ${n(WIND_UP)} WIND-UP NOTICE in docs/effort-guide.md, and a floor, being one turn stale.`,
				"",
				`This is not a stop. Finish the unit of work in flight — one build-unit ticket, however many compactions finishing it takes short of the ${COMPACTION_BACKSTOP}th, where the compaction hook's hand-off governs, or one bundle member — even if a compaction fires while you do, and start no new one. A review's fix-here findings are part of that unit: ticketing one does not finish it (workflow-core#4492). Commit. A unit with an unticked criterion is not finished, and no ticket comment or body note moves its boundary (workflow-core#4495): the only exits before its close are ${EXITS}. Only once the unit is finished, comment its state on a still-open parent of it — spec, map or bundle — and leave that parent open. The next unit goes to a fresh session.`,
				"",
				closing,
				"",
				readFounderDeliverableRule(firstBlock.windUp),
				"",
				`THIS FIRES AGAIN AND AGAIN FROM HERE ON, not once (mantahostels#2601) — at every other Stop ending on \`result:\` or no status marker, the one straight after each block being stood down; \`waiting:\` and \`needs input:\` pass and spend no block (workflow-core#919). Every further turn costs one of its own, so the cheap move is to finish and end rather than to read past it. Read the figure yourself with \`node ${scriptPath("session-context.js")}\`.`,
			].join("\n"),
		};
	if (turns >= TURN_BAND)
		return {
			band: "turns",
			reason: [
				`This session has made ${n(turns)} model responses — past the ${n(TURN_BAND)}-TURN NOTICE in docs/effort-guide.md, and a floor, being one turn stale. A turn here is one model response, each tool call included, not one message from the founder.`,
				"",
				`Standing context now reads ${n(tokens)} tokens. Spend is turns x standing context, so a long session costs even where that reading is low — after a compaction included.`,
				"",
				`This is a notice, not a limit and not a stop. Finish the ticket in hand — the build unit, however many compactions it takes short of the ${COMPACTION_BACKSTOP}th, where the compaction hook's hand-off governs, every step it still needs, its close included — even if a compaction fires while you do, then end. What it rules out is STARTING a different ticket or bundle member. Never leave the ticket in hand's remaining steps to a fresh session on the strength of this notice: a fresh session re-reads everything this one already holds, and saves nothing.`,
				"",
				closing,
				"",
				readFounderDeliverableRule(firstBlock.turns),
				"",
				"THIS FIRES AGAIN, up to three times in all (mantahostels#2619) — at every other Stop ending on `result:` or no status marker, the one straight after each block being stood down; `waiting:` and `needs input:` pass (workflow-core#919). Every further turn costs one of its own, so the cheap move is to finish and end rather than to read past it.",
			].join("\n"),
		};
	return null;
}

/**
 * workflow-core#1452
 * @param {number} tokens
 * @param {string} closing
 */
function buildTripwireReason(tokens, closing) {
	return [
		`Standing context is ${n(tokens)} tokens — past the ${n(TRIPWIRE)} TRIPWIRE in docs/effort-guide.md, and a floor, being one turn stale.`,
		"",
		"Reaching it means autocompaction did not fire before it. Check `autoCompactWindow` in the project's `.claude/settings.json`: it must be an integer, such as 320000. The key silently drops any other value, and the default then fires at ~967,000.",
		"",
		"Commit what exists, comment the unfinished state on any open issue you are working, and end your turn. Start no new unit of work.",
		"",
		closing,
		"",
		readFounderDeliverableRule(true),
		"",
		`This fires once per session. Read the figure yourself with \`node ${scriptPath("session-context.js")}\`.`,
	].join("\n");
}

/**
 * @param {number} count
 */
function compactionParagraph(count) {
	return `${buildCompactionSentence(count)} The standing-context figure restarted from the compaction's summary, so it understates what this session has carried.`;
}

/**
 * @param {string} what
 * @param {unknown} err
 */
function logFailOpen(what, err) {
	ignoreFailure(() =>
		require("./lib/arbiter-core").logError(
			`guard-session-ceiling ${what}`,
			err,
		),
	);
}

/**
 * @param {string} sid
 * @param {"main"|"subagent"} tier
 */
function hasParkedBlocked(sid, tier) {
	if (tier !== "main") return false;
	return fs.existsSync(blockedRecordOf(sid, hookBlock.repoRoot()));
}

/**
 * @param {Payload} payload
 * @param {string} file
 * @returns {{message: string, marker: string} | null}
 */
function readSessionEnding(payload, file) {
	const message = readMessageText(payload, file, (err) =>
		logFailOpen("message", err),
	);
	if (!message) return null;
	const { name } = governingMarker(message);
	return name === "" || name === "result:" ? { message, marker: name } : null;
}

/**
 * @param {string} message
 * @param {string} sid
 */
function hasPassingInventory(message, sid) {
	try {
		// workflow-core#1249
		return require("./guard-inventory").hasPassingInventory(message, sid);
	} catch (err) {
		logFailOpen("inventory", err);
		return false;
	}
}

/** @param {string} file */
function readPendingLaunches(file) {
	try {
		const seen = readPendingTasks(file);
		return seen.records ? seen.pending : [];
	} catch (err) {
		logFailOpen("pending", err);
		return [];
	}
}

/**
 * @param {{sessionId: string, payload: Payload,
 *   note: (outcome: string, payload?: Payload) => void}} ctx
 */
function review({ sessionId: sid, payload, note }) {
	const file = sessionTranscript.resolve(payload, sid);
	if (!file) {
		note("no-transcript", payload);
		return;
	}

	let read;
	let turns = 0;
	/** @type {"main"|"subagent"} */
	let tier = "main";
	/** @type {string[]} */
	let boundaries = [];
	try {
		const text = sessionTranscript.read(file);
		tier = isSubagentTranscript(file) ? "subagent" : "main";
		read = lastStandingContext(text, tier);
		turns = countTurns(text, tier);
		boundaries = autocompactions(text, tier);
	} catch {
		note("unreadable-transcript", payload);
		return;
	}
	// workflow-core#1785
	const compactions =
		tier === "main" ? recordCompactions(sid, boundaries) : boundaries.length;
	if (!read) {
		note("empty-message", payload);
		return;
	}

	let outcome = "message";
	try {
		outcome = judge({ sid, payload, file, read, turns, tier, compactions });
	} finally {
		note(outcome, payload);
	}
}

/**
 * @param {{sid: string, payload: Payload, file: string,
 *   read: {tokens: number}, turns: number, tier: "main"|"subagent",
 *   compactions: number}} ctx
 * @returns {"message" | "inventory-stand-down"}
 */
function judge({ sid, payload, file, read, turns, tier, compactions }) {
	/** @param {string} reason */
	const withCount = (reason) =>
		compactions ? `${reason}\n\n${compactionParagraph(compactions)}` : reason;

	// lucmoseley/mantahostels#2601
	if (payload?.stop_hook_active === true) return "message";

	const tripwireSpent = isTripwireSpent(sid);
	const pending =
		read.tokens >= WIND_UP || turns >= TURN_BAND
			? readPendingLaunches(file)
			: [];
	const band = bandFor(
		read.tokens,
		turns,
		{
			tripwire: !tripwireSpent,
			windUp:
				!tripwireSpent &&
				!hookBlock.capSpent({
					prefix: ".session-ceiling-nagged-windup-",
					sessionId: sid,
					max: 1,
				}),
			turns: !hookBlock.capSpent({
				prefix: ".session-ceiling-nagged-turns-",
				sessionId: sid,
				max: 1,
			}),
		},
		closingSteps(pending),
	);
	if (!band) return "message";
	if (band.band === "tripwire") {
		hookBlock.blockStop({
			prefix: TRIPWIRE_PREFIX,
			sessionId: sid,
			reason: withCount(band.reason),
			max: 1,
		});
		return "message";
	}
	// workflow-core#53
	if (
		band.band === "wind-up" &&
		pending.length === 0 &&
		hasParkedBlocked(sid, tier)
	)
		return "message";
	// workflow-core#919
	const ending = readSessionEnding(payload, file);
	if (!ending) return "message";
	if (
		ending.marker === "result:" &&
		pending.length === 0 &&
		hasPassingInventory(ending.message, sid)
	)
		return "inventory-stand-down";
	if (band.band === "turns") {
		hookBlock.blockStop({
			prefix: ".session-ceiling-nagged-turns-",
			sessionId: sid,
			reason: withCount(band.reason),
			max: TURN_BAND_MAX_BLOCKS,
		});
		return "message";
	}
	// lucmoseley/mantahostels#2601
	hookBlock.blockStop({
		prefix: ".session-ceiling-nagged-windup-",
		sessionId: sid,
		reason: withCount(band.reason),
		max: Number.POSITIVE_INFINITY,
	});
	return "message";
}

if (require.main === module) stopGuard.onPayload({ review, record: true });
