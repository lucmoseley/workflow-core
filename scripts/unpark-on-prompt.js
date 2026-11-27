#!/usr/bin/env node
const path = require("node:path");
const { ignoreFailure } = require("./lib/caught.js");
const { isFounderTyping } = require("./lib/founder-typing");
const hookMessage = require("./lib/hook-message");
const { hostRoot } = require("./lib/host-root");
const { trackerOf } = require("./lib/outstanding-line");
const { readParkedBy, unparkIssues } = require("./lib/parked");
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
	unparkIssues(tracker, sid, parked);
}

// workflow-core#2000
ignoreFailure(main);
