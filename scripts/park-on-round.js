#!/usr/bin/env node
/*
 * park-on-round.js — Stop hook. Labels `parked` the issue a background job's
 * `needs input:` ending posted its question round on, where this session
 * claims it, so no picker relaunches the ticket while the round waits on the
 * founder (#2000, spec #1995).
 *
 * THE CONDITION is guard-inventory.js's own (#1066), read through its
 * `parkTargets`: an ending that guard would refuse parks nothing, and the
 * re-sent ending parks once it passes.
 *
 * IN NO §N3 FAMILY: it refuses nothing and checks nothing — it writes a
 * label.
 *
 * FAILS OPEN (lib/stop-guard.js): an unreadable claim store, tracker or
 * GitHub parks nothing, and a failed label write leaves the issue unmarked.
 *
 * IMPLICIT:  at a background job's `needs input:` Stop whose round is posted on an issue this session claims, adds the `parked` label to that issue and records it in the session's `.parked-` marker.
 * JUSTIFIED: fail-safe — a parked ticket left on the frontier is relaunched every refill, and each relaunch re-asks the same round (#1995).
 * DEFEAT:    none needed — it never blocks.
 */

const { parkTargets } = require("./guard-inventory");
const { markParked, readParkedBy, setParked } = require("./lib/parked");
const stopGuard = require("./lib/stop-guard");
const { trackerOf } = require("./lib/outstanding-line");

/** @param {{sessionId: string, message: string}} ctx */
function review({ sessionId, message }) {
	const targets = parkTargets(message, sessionId);
	const tracker = trackerOf();
	if (targets.length === 0 || !tracker) return;
	const parked = targets.filter((n) => setParked(tracker, n, true) === null);
	if (parked.length > 0)
		markParked(sessionId, [...readParkedBy(sessionId), ...parked]);
}

if (require.main === module) stopGuard.onMessage({ review });
