/*
 * landing-stall.js — what the session-start stall check reads off the landing
 * queue (workflow-core#2406, spec workflow-core#2261): a stalled queue, a dead lander, or a held one.
 *
 * STALLED: the oldest commit on `landing` not on `main` was committed over
 * STALL_MS ago. Its committer time stands in for its push time, which git
 * does not keep, so a commit pushed long after it was made reads as waiting
 * from its commit.
 *
 * Both below need `landing` ahead of `main` and the pid the heartbeat names
 * not running. A live pid with a stale beat is a lander inside one push,
 * which beats only between git calls; residual: a hung lander, or a reused
 * pid, reads alive and is caught by the stall alone.
 *
 * HELD: the last run held with `landing` at its present tip, which a run
 * leaves alone until a push moves it.
 *
 * DEAD: otherwise, where the heartbeat is absent or older than STALE_MS.
 */

const { HEARTBEAT_MS, short } = require("./lander.js");

/* Spec workflow-core#2261, untraced there: the accepted 60 min ceiling plus one maximum
 * suite run of ~30 min. */
const STALL_MS = 90 * 60 * 1000;
/* Untraced: five missed beats, so one slow tester tick is never read as a
 * death. */
const STALE_MS = 5 * HEARTBEAT_MS;

/**
 * @typedef {{tag: "LANDING-STALLED" | "LANDER-DEAD" | "LANDING-HELD",
 *   line: string}} StallFinding
 * @typedef {object} QueueReading
 * @property {number} now
 * @property {string|null} landing `landing`'s sha
 * @property {import("./lander.js").Relation} relation
 * @property {{sha: string, at: number}|null} oldest the oldest commit on
 *   `landing` not on `main`, by committer time in ms
 * @property {import("./lander.js").Heartbeat|null} heartbeat
 * @property {(pid: number) => boolean} alive
 */

/**
 * @param {QueueReading} r
 * @returns {StallFinding[]}
 */
function stallFindings({ now, landing, relation, oldest, heartbeat, alive }) {
	/** @type {StallFinding[]} */
	const found = [];
	if (oldest !== null && now - oldest.at > STALL_MS)
		found.push({
			tag: "LANDING-STALLED",
			line: `landing holds ${short(oldest.sha)}, committed ${new Date(oldest.at).toISOString()}, not on main after ${STALL_MS / 60_000} min (landing is ${relation} of main)`,
		});
	if (relation !== "ahead" || landing === null) return found;
	if (heartbeat !== null && alive(heartbeat.pid)) return found;
	const hold = heartbeat?.hold;
	if (hold && hold.landing === landing)
		found.push({
			tag: "LANDING-HELD",
			line: `the lander holds landing at ${short(landing)}: ${hold.reason}. ${hold.filed}`,
		});
	else if (!(heartbeat && now - Date.parse(heartbeat.at) <= STALE_MS))
		found.push({
			tag: "LANDER-DEAD",
			line: `landing ${short(landing)} is ahead of main and no lander is running, its heartbeat ${heartbeat ? `last written ${heartbeat.at}` : "absent"}`,
		});
	return found;
}

module.exports = { stallFindings };
