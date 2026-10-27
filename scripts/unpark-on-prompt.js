#!/usr/bin/env node
/*
 * unpark-on-prompt.js — UserPromptSubmit hook. Takes `parked` off the issues
 * this session parked when the founder types in it — his answer to the round,
 * through `claude attach` — so the ticket returns to the frontier if the
 * session hands it on (workflow-core#2000, spec workflow-core#1995).
 *
 * Reads the session's `.parked-` marker (lib/parked.js) and acts only where
 * it lists an issue. An issue whose label write fails stays in the marker, for
 * the next prompt to retry.
 *
 * IN NO §N3 FAMILY: it refuses nothing and checks nothing — it writes a
 * label.
 *
 * FAILS OPEN: prints nothing and never blocks the prompt; any error leaves the
 * label for claim-issue.js to clear.
 *
 * IMPLICIT:  at every prompt in a session whose `.parked-` marker lists an issue, removes the `parked` label from it and drops it from the marker.
 * JUSTIFIED: fail-safe — an answered ticket left parked stays off the frontier, and no picker launches it again (workflow-core#1995).
 * DEFEAT:    none needed — it never blocks; `disabled` in .claude/workflow-core.json stands it down.
 */

const path = require("node:path");
const hookMessage = require("./lib/hook-message");
const { hostRoot } = require("./lib/host-root");
const { trackerOf } = require("./lib/outstanding-line");
const { markParked, readParkedBy, setParked } = require("./lib/parked");
const sessionId = require("./lib/session-id");
const { guardDisabled } = require("./lib/workflow-core-config");

function main() {
	if (guardDisabled(path.basename(__filename), { root: hostRoot() })) return;
	const sid = sessionId.fromPayload(hookMessage.readPayload());
	if (!sid) return;
	const parked = readParkedBy(sid);
	const tracker = parked.length > 0 ? trackerOf() : null;
	if (!tracker) return;
	markParked(
		sid,
		parked.filter((n) => setParked(tracker, n, false) !== null),
	);
}

try {
	main();
} catch {
	/* Fail open (workflow-core#2000). */
}
