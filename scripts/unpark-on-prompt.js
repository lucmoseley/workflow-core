#!/usr/bin/env node
/*
 * unpark-on-prompt.js — UserPromptSubmit hook. Takes `parked` off the issues
 * this session parked when the founder types in it — his answer to the round,
 * through `claude attach` — so the ticket returns to the frontier if the
 * session hands it on (#2000, spec #1995).
 *
 * Reads the session's `.parked-` marker (lib/parked.js) and acts only where
 * it lists an issue and the prompt is his typing (lib/founder-typing.js). An
 * issue whose label write fails stays in the marker, for the next prompt to
 * retry.
 *
 * IN NO §N3 FAMILY: it refuses nothing and checks nothing — it writes a
 * label.
 *
 * FAILS OPEN: prints nothing and never blocks the prompt; any error leaves the
 * label for claim-issue.js to clear.
 *
 * IMPLICIT:  at every prompt the founder types in a session whose `.parked-` marker lists an issue, removes the `parked` label from it and drops it from the marker.
 * JUSTIFIED: fail-safe — an answered ticket left parked stays off the frontier, and no picker launches it again (#1995).
 * DEFEAT:    none needed — it never blocks; `disabled` in .claude/workflow-core.json stands it down.
 */

const path = require("node:path");
const { isFounderTyping } = require("./lib/founder-typing");
const hookMessage = require("./lib/hook-message");
const { hostRoot } = require("./lib/host-root");
const { trackerOf } = require("./lib/outstanding-line");
const { setParked } = require("./lib/parked");
const { readParkedBy, writeParkedBy } = require("./lib/parked-marker.js");
const sessionId = require("./lib/session-id");
const { guardDisabled } = require("./lib/workflow-core-config");

function main() {
	if (guardDisabled(path.basename(__filename), { root: hostRoot() })) return;
	const payload = hookMessage.readPayload();
	if (!isFounderTyping(payload)) return;
	const sid = sessionId.fromPayload(payload);
	if (!sid) return;
	const parked = readParkedBy(sid);
	const tracker = parked.length > 0 ? trackerOf() : null;
	if (!tracker) return;
	writeParkedBy(
		sid,
		parked.filter((n) => setParked(tracker, n, false) !== null),
	);
}

try {
	main();
} catch {
	/* Fail open (#2000). */
}
