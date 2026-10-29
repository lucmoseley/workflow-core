#!/usr/bin/env node
/*
 * guard-exhausted-map.js — Stop hook. Refuses the stop of a session holding
 * the arbiter claim on an exhausted map: a `wayfinder:map` that is open,
 * still `takes:wayfinder`, not `parked`, not gated, and has no open sub-issue
 * (#3639, spec #3623).
 *
 * WHY. The refill loop launches `/wayfinder <map>` for such a map, and nothing
 * else routes it, so a session that ends having given it no new route leaves
 * it to be relaunched every tick — three such finishes trip the loop's
 * no-progress stop. The routes are an open child, a hand-off relabel, a gate,
 * a park and a close (`rule:wayfinder-ops-shapes` §Exhausted map).
 *
 * ON Stop, NOT ON THE CLOSE OF THE LAST CHILD: a close-path check cannot see
 * a close made in the web UI or through `gh api`.
 *
 * CHILDREN COME FROM `/sub_issues`, never this repo's issue list, so an open
 * child in another repo counts (lib/issue-tree.js).
 *
 * A PARKING TURN PASSES: a `needs input:` ending whose round park-on-round.js
 * parks the map this same Stop is itself the park route, read through the
 * same `parkTargets` that hook uses, since both hooks run at once.
 *
 * IMPLICIT:  at every Stop of a session holding an issue claim, reads each
 *            claimed issue from GitHub and refuses the turn where one is an
 *            exhausted map.
 * JUSTIFIED: fail-safe — an exhausted map the session leaves unrouted is
 *            launched by nothing but this session's own command, so it strands
 *            or loops (#3570).
 * DEFEAT:    at most three blocks a session; silent with no claim, on a parking
 *            turn, and on every read error.
 */

const { parkTargets } = require("./guard-inventory");
const { logError, listIssueClaims } = require("./lib/arbiter-store");
const { ghJson } = require("./lib/gh");
const hookBlock = require("./lib/hook-block");
const hookMessage = require("./lib/hook-message");
const { MAP_LABEL, resolveGate } = require("./lib/issue-gate");
const { isOpenChild, readSubIssues } = require("./lib/issue-tree");
const { trackerOf } = require("./lib/outstanding-line");
const { PARKED_LABEL } = require("./lib/parked");
const stopGuard = require("./lib/stop-guard");

const TAKES_WAYFINDER = "takes:wayfinder";

/* Each read's cap: the registration's timeout is 15 s, and a session holding
 * one map makes two reads. */
const READ_TIMEOUT_MS = 5000;

/**
 * The issues this session claims, or [] where the store cannot be read whole.
 * @param {string} sid
 * @returns {number[]}
 */
function claimedIssues(sid) {
	const listed = listIssueClaims();
	if (!listed || listed.why) return [];
	return listed.claims
		.filter((c) => c?.sessionId === sid && typeof c.issue === "number")
		.map((c) => c.issue);
}

/**
 * Whether `n` in `tracker` is an exhausted map. Throws on a read error.
 * @param {string} tracker
 * @param {number} n
 */
function isExhaustedMap(tracker, n) {
	const opts = { timeout: READ_TIMEOUT_MS };
	const issue = ghJson(["api", `repos/${tracker}/issues/${n}`], opts);
	/** @type {string[]} */
	const labels = (issue.labels ?? []).map(
		(/** @type {{name: string}} */ l) => l.name,
	);
	if (issue.state !== "open" || !labels.includes(MAP_LABEL)) return false;
	if (!labels.includes(TAKES_WAYFINDER) || labels.includes(PARKED_LABEL))
		return false;
	const { gateHolds, gateOnHolds } = resolveGate(issue.body ?? "");
	if (gateHolds || gateOnHolds) return false;
	return !readSubIssues(n, tracker, opts).some(isOpenChild);
}

/**
 * The maps this turn's own ending parks, or [] where the message is unread.
 * @param {import('./lib/stop-guard.js').StopPayload} payload
 * @param {string} sid
 */
function parkedThisTurn(payload, sid) {
	const transcript = hookMessage.transcriptPath(payload, sid);
	const message = hookMessage.readMessageText(payload, transcript, (err) =>
		logError("guard-exhausted-map message", err),
	);
	return message ? parkTargets(message, sid) : [];
}

/**
 * @param {number[]} maps
 */
function buildReason(maps) {
	const named = maps.map((n) => `#${n}`).join(", ");
	return (
		`This session claims ${named}, a \`wayfinder:map\` still \`takes:wayfinder\` with no open sub-issue, no gate and no \`parked\` label — so it routes nowhere but back to this command (\`rule:wayfinder-ops-shapes\` §Exhausted map). Before ending, in order:\n` +
		"  (a) While *Not yet specified* holds anything, graduate at least one patch into a ticket under the map — or into a grilling ticket for the founder where it is too vague to phrase precisely — or rule it out of scope.\n" +
		"  (b) Once *Not yet specified* is empty, take one of the three exhausted-map branches: relabel the map to the hand-off command's `takes:` value, label it `takes:children` with one `kind:brief` per deliverable, or write the dormant gate line.\n" +
		"  (c) Where the map's destination is reached, close it.\n" +
		"Then re-send the message this turn was going to end on, its status marker included — this block discarded it."
	);
}

/**
 * @param {{sessionId: string, payload: import('./lib/stop-guard.js').StopPayload}} ctx
 */
function judge({ sessionId: sid, payload }) {
	const claimed = claimedIssues(sid);
	const tracker = trackerOf();
	if (claimed.length === 0 || !tracker) return;
	if (hookBlock.capSpent({ prefix: ".exhausted-map-nagged-", sessionId: sid }))
		return;
	let exhausted;
	try {
		exhausted = claimed.filter((n) => isExhaustedMap(tracker, n));
	} catch (err) {
		logError("guard-exhausted-map read", err);
		return;
	}
	if (exhausted.length === 0) return;
	const parking = parkedThisTurn(payload, sid);
	const owed = exhausted.filter((n) => !parking.includes(n));
	if (owed.length === 0) return;
	hookBlock.blockStop({
		prefix: ".exhausted-map-nagged-",
		sessionId: sid,
		reason: buildReason(owed),
	});
}

if (require.main === module) stopGuard.onPayload({ review: judge });
