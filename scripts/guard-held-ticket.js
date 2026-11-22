#!/usr/bin/env node

const { logError, readClaimedIssues } = require("./lib/arbiter-store");
const {
	COMPACTION_BACKSTOP,
	countCompactions,
} = require("./lib/compaction-set");
const { EXITS, isUnfinishedUnitIn, UNFINISHED } = require("./lib/held-unit");
const hookBlock = require("./lib/hook-block");
const hookMessage = require("./lib/hook-message");
const { trackerOf } = require("./lib/outstanding-line");
const sessionTranscript = require("./lib/session-transcript");
const { scriptPath } = require("./lib/script-path");
const { isTripwireSpent, TRIPWIRE } = require("./lib/session-tripwire");
const { governingMarker } = require("./lib/status-marker");
const stopGuard = require("./lib/stop-guard");
const {
	isSubagentTranscript,
	lastStandingContext,
} = require("./lib/transcript");

const HELD_TICKET_PREFIX = ".held-ticket-nagged-";

/**
 * @param {import('./lib/stop-guard.js').StopPayload} payload
 * @param {string} sid
 * @returns {boolean|null}
 */
function isPastTripwire(payload, sid) {
	if (isTripwireSpent(sid)) return true;
	const file = sessionTranscript.resolve(payload, sid);
	if (!file) return null;
	try {
		const tier = isSubagentTranscript(file) ? "subagent" : "main";
		const read = lastStandingContext(sessionTranscript.read(file), tier);
		return read ? read.tokens >= TRIPWIRE : null;
	} catch (err) {
		logError("guard-held-ticket transcript", err);
		return null;
	}
}

/**
 * @param {number[]} units
 */
function buildReason(units) {
	const named = units.map((n) => `#${n}`).join(", ");
	return (
		`This session claims ${named}, ${UNFINISHED} — so the build unit is not finished, and this turn would end the session on it. No ticket comment or body note moves a unit's boundary; it was set at filing by the size line (\`rule:size-line\`).\n` +
		`Carry on with the unit: its remaining criteria, the closing review, and the close through \`node ${scriptPath("resolve-ticket.js")}\`, which releases the claim.\n` +
		`Where it genuinely cannot be finished, leave by one of the four exits: ${EXITS}.\n` +
		"Then re-send the message this turn was going to end on, its status marker included — this block discarded it."
	);
}

/**
 * @param {{sessionId: string, payload: import('./lib/stop-guard.js').StopPayload}} ctx
 */
function judge({ sessionId: sid, payload }) {
	const claimed = readClaimedIssues(sid);
	const tracker = trackerOf();
	if (claimed.length === 0 || !tracker) return;
	if (hookBlock.capSpent({ prefix: HELD_TICKET_PREFIX, sessionId: sid }))
		return;
	const message = hookMessage.readMessageText(
		payload,
		hookMessage.transcriptPath(payload, sid),
		(err) => logError("guard-held-ticket message", err),
	);
	if (!message) return;
	const { name } = governingMarker(message);
	if (name !== "" && name !== "result:") return;
	if (countCompactions(sid) >= COMPACTION_BACKSTOP) return;
	if (isPastTripwire(payload, sid) !== false) return;
	const deadline = Date.now() + stopGuard.READ_BUDGET_MS;
	let units;
	try {
		units = claimed.filter((n) => {
			const timeout = deadline - Date.now();
			if (timeout <= 0) throw new Error("read budget spent");
			return isUnfinishedUnitIn(tracker, n, { timeout });
		});
	} catch (err) {
		logError("guard-held-ticket read", err);
		return;
	}
	if (units.length === 0) return;
	hookBlock.blockStop({
		prefix: HELD_TICKET_PREFIX,
		sessionId: sid,
		reason: buildReason(units),
	});
}

if (require.main === module) stopGuard.onPayload({ review: judge });
