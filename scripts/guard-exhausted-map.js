#!/usr/bin/env node

const { parkTargets } = require("./guard-inventory");
const { logError, readClaimedIssues } = require("./lib/arbiter-store");
const { ghJson } = require("./lib/gh");
const hookBlock = require("./lib/hook-block");
const hookMessage = require("./lib/hook-message");
const { isGateHolding, MAP_LABEL } = require("./lib/issue-gate");
const { isOpenChild, readSubIssues } = require("./lib/issue-tree");
const { trackerOf } = require("./lib/outstanding-line");
const { PARKED_LABEL } = require("./lib/parked");
const stopGuard = require("./lib/stop-guard");

const TAKES_WAYFINDER = "takes:wayfinder";
const EXHAUSTED_MAP_PREFIX = ".exhausted-map-nagged-";

/**
 * @param {string} tracker
 * @param {number} n
 * @param {number} deadline
 */
function isExhaustedMap(tracker, n, deadline) {
	const opts = () => {
		const timeout = deadline - Date.now();
		if (timeout <= 0) throw new Error("read budget spent");
		return { timeout };
	};
	const issue = ghJson(["api", `repos/${tracker}/issues/${n}`], opts());
	/** @type {string[]} */
	const labels = (issue.labels ?? []).map(
		(/** @type {{name: string}} */ l) => l.name,
	);
	if (issue.state !== "open" || !labels.includes(MAP_LABEL)) return false;
	if (!labels.includes(TAKES_WAYFINDER) || labels.includes(PARKED_LABEL))
		return false;
	if (isGateHolding(issue.body ?? "")) return false;
	return !readSubIssues(n, tracker, opts()).some(isOpenChild);
}

/**
 * @param {import('./lib/stop-guard.js').StopPayload} payload
 * @param {string} sid
 * @returns {number[]|null}
 */
function readParkedThisTurn(payload, sid) {
	const transcript = hookMessage.transcriptPath(payload, sid);
	const message = hookMessage.readMessageText(payload, transcript, (err) =>
		logError("guard-exhausted-map message", err),
	);
	return message ? parkTargets(message, sid) : null;
}

/**
 * @param {number[]} maps
 */
function buildReason(maps) {
	const named = maps.map((n) => `#${n}`).join(", ");
	return (
		`This session claims ${named}, a \`wayfinder:map\` still \`takes:wayfinder\` with no open sub-issue, no gate and no \`parked\` label — so it routes nowhere but back to this command (\`rule:wayfinder-ops-shapes\` §Exhausted map). Before ending, in order:\n` +
		"  (a) While *Not yet specified* holds anything, graduate at least one patch into a ticket under the map — or into a grilling ticket for the founder where it is too vague to phrase precisely — or rule it out of scope.\n" +
		"  (b) Once *Not yet specified* is empty, take one of the three branches below.\n" +
		"  (c) Where the map's destination is reached, close it.\n" +
		"The three branches:\n" +
		"  - **The map's destination is a hand-off to another command — a spec, tickets, an implementation:** relabel it to that command's `takes:` value (`takes:to-spec` for `/to-spec <map>`) and write no gate.\n" +
		"  - **The map ends in several destinations, one brief filed under it per deliverable:** label each brief `kind:brief`, and the map `takes:children`.\n" +
		"  - **The map is dormant on something outside the tracker:** write the gate line — `rule:roadmap-gating`'s condition row, the condition being what would re-open the map.\n" +
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
	if (hookBlock.capSpent({ prefix: EXHAUSTED_MAP_PREFIX, sessionId: sid }))
		return;
	const deadline = Date.now() + stopGuard.READ_BUDGET_MS;
	let exhausted;
	try {
		exhausted = claimed.filter((n) => isExhaustedMap(tracker, n, deadline));
	} catch (err) {
		logError("guard-exhausted-map read", err);
		return;
	}
	if (exhausted.length === 0) return;
	const parking = readParkedThisTurn(payload, sid);
	if (parking === null) return;
	const owed = exhausted.filter((n) => !parking.includes(n));
	if (owed.length === 0) return;
	hookBlock.blockStop({
		prefix: EXHAUSTED_MAP_PREFIX,
		sessionId: sid,
		reason: buildReason(owed),
	});
}

if (require.main === module) stopGuard.onPayload({ review: judge });
