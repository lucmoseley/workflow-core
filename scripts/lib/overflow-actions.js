/*
 * overflow-actions.js — what the overflow view (lib/overflow-viewer.js, #4583)
 * does to a session's latest run: reply, resuming it headless with the reply as
 * its next turn on the same seat and key through lib/headless-sessions.js,
 * which hands the key to the child through the `apiKeyHelper` alone; and stop,
 * through lib/claude-stop.js, as the refill tick's does.
 */

const { stopOn } = require("./claude-stop.js");
const { launch } = require("./headless-sessions.js");
const { hostRoot } = require("./host-root.js");
const { seatBudget } = require("./overflow-budget.js");
const { findOverflowSeat, readDeclaredSeats } = require("./refill-seats.js");

/** @typedef {import("./headless-runs.js").RunRecord} RunRecord */

/* A reply's spend ceiling, as `--max-budget-usd`. Untraced. */
const REPLY_BUDGET_USD = 15;

/**
 * The headroom for one more run on `run`'s seat, gated as the dispatcher gates
 * a launch (scripts/dispatch-sessions.sh): nothing past it. A key the seat file
 * now gives another seat is refused, as that seat's config dir holds no record
 * of the session.
 * @param {RunRecord} run
 * @returns {{usd: number}|{why: string}}
 */
function readHeadroom(run) {
	const seat = findOverflowSeat(readDeclaredSeats(), run.keyVar);
	if (!seat)
		return {
			why: `${run.keyVar} is not an overflow seat's key in the seat file`,
		};
	if (seat.dir !== run.seat)
		return {
			why: `${run.keyVar} is now ${seat.dir}'s key, and the session is on ${run.seat}`,
		};
	const budget = seatBudget(seat, hostRoot());
	if ("why" in budget) return budget;
	if (budget.exhausted || budget.fit === 0)
		return { why: "the key's budget does not fit a reply" };
	return { usd: budget.headroomUsd };
}

/**
 * Resume `run`'s session headless with `text` as its next turn.
 * @param {RunRecord} run
 * @param {string} text
 * @param {(run: RunRecord) => {usd: number}|{why: string}} [headroomOf]
 * @returns {{jobId: string}|{why: string}}
 */
function sendReply(run, text, headroomOf = readHeadroom) {
	const headroom = headroomOf(run);
	if ("why" in headroom) return headroom;
	const out = launch({
		keyVar: run.keyVar,
		cwd: run.cwd,
		budgetUsd: Math.min(REPLY_BUDGET_USD, headroom.usd),
		prompt: text,
		resume: run.sessionId,
	});
	return "why" in out ? out : { jobId: out.record.jobId };
}

/**
 * @param {RunRecord} run
 * @returns {{ok: true, said: string}|{ok: false, why: string}}
 */
const stopRun = (run) => stopOn(run.seat, run.jobId);

module.exports = { readHeadroom, sendReply, stopRun };
