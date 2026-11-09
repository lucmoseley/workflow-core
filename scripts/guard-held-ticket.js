#!/usr/bin/env node
/*
 * guard-held-ticket.js — Stop hook. Refuses a turn ending `result:` or with no
 * status marker while the session holds the arbiter claim on an unfinished
 * build unit: an open, unparked `kind:ticket` with an unticked, unwaived
 * criterion (lib/held-unit.js; #4535, on #4495's ruling).
 *
 * WHY. A session ended its claimed ticket after one of its eleven slices, the
 * claim left standing and the criteria unticked, and nothing refused the
 * ending (#4495). A unit's boundary is set at filing (`rule:size-line`), and
 * no ticket comment or body note moves it.
 *
 * WHAT PASSES: a `needs input:` or `waiting:` ending, which is the park route
 * and the wait; a session past the 300,000 tripwire — its reading at or past
 * it now, or the tripwire's one block already spent — and one at the
 * compaction backstop, whose hand-offs govern instead; a turn whose message or
 * transcript cannot be read.
 *
 * IMPLICIT:  at every Stop of a session holding an issue claim and ending on
 *            `result:` or no marker, reads each claimed issue from GitHub and
 *            refuses the turn where one is an unfinished build unit.
 * JUSTIFIED: fail-safe — a session that ends with its unit unfinished leaves
 *            the claim hiding the issue and the remaining criteria to no one
 *            (#4495).
 * DEFEAT:    at most three blocks a session; silent with no claim, on a
 *            `needs input:` or `waiting:` ending, past the tripwire, at the
 *            backstop, and on every read error.
 * TREE:      host — claims, counters, the compaction set and the tracker are the host root's
 */

const { logError, readClaimedIssues } = require("./lib/arbiter-store");
const {
	COMPACTION_BACKSTOP,
	countCompactions,
} = require("./lib/compaction-set");
const { EXITS, readUnfinishedUnit } = require("./lib/held-unit");
const hookBlock = require("./lib/hook-block");
const hookMessage = require("./lib/hook-message");
const { trackerOf } = require("./lib/outstanding-line");
const sessionTranscript = require("./lib/session-transcript");
const { scriptPath } = require("./lib/script-path");
const { governingMarker } = require("./lib/status-marker");
const stopGuard = require("./lib/stop-guard");
const {
	isSubagentTranscript,
	lastStandingContext,
} = require("./lib/transcript");
const { TRIPWIRE } = require("./guard-session-ceiling");

const HELD_TICKET_PREFIX = ".held-ticket-nagged-";

/* Every read's cap together, as guard-exhausted-map.js's: the registration's
 * timeout is 15 s. A session claims the one issue it works, so one read. */
const READ_BUDGET_MS = 10_000;

/**
 * Whether the tripwire's hand-off governs: the reading is at or past it, or
 * its one block is spent. Null where the transcript will not read.
 * @param {import('./lib/stop-guard.js').StopPayload} payload
 * @param {string} sid
 * @returns {boolean|null}
 */
function pastTripwire(payload, sid) {
	if (
		hookBlock.capSpent({
			prefix: ".session-ceiling-nagged-hard-",
			sessionId: sid,
			max: 1,
		})
	)
		return true;
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
		`This session claims ${named}, an open \`kind:ticket\` with an unticked, unwaived acceptance criterion and no \`parked\` label — so the build unit is not finished, and this turn would end the session on it (#4495). No ticket comment or body note moves a unit's boundary; it was set at filing by the size line (\`rule:size-line\`).\n` +
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
	if (pastTripwire(payload, sid) !== false) return;
	const deadline = Date.now() + READ_BUDGET_MS;
	let units;
	try {
		units = claimed.filter((n) => {
			const timeout = deadline - Date.now();
			if (timeout <= 0) throw new Error("read budget spent");
			return readUnfinishedUnit(tracker, n, { timeout });
		});
	} catch (err) {
		/* Fails open: a unit read short may be finished. */
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
