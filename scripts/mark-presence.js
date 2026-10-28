#!/usr/bin/env node
/*
 * mark-presence.js — UserPromptSubmit hook. Records that the founder typed a
 * prompt, so the refill loop can tell present from away (#2004, spec #1995).
 *
 * What is not his typing is lib/founder-typing.js's to say.
 *
 * BLIND SPOT: a session whose repo does not run this plugin writes nothing,
 * so a prompt typed there reads him as away.
 *
 * IN NO §N3 FAMILY: it refuses nothing and checks nothing — it writes a
 * marker.
 *
 * FAILS OPEN: prints nothing and never blocks the prompt.
 *
 * IMPLICIT:  at every prompt typed in an interactive session or into a running background job, writes the time to `~/.claude/.founder-presence`.
 * JUSTIFIED: fail-safe — a missed prompt reads him as away (#1995).
 * DEFEAT:    none needed — it never blocks; `disabled` in .claude/workflow-core.json stands it down.
 */

const path = require("node:path");
const { isFounderTyping } = require("./lib/founder-typing");
const hookMessage = require("./lib/hook-message");
const { hostRoot } = require("./lib/host-root");
const { markPresent } = require("./lib/presence");
const { guardDisabled } = require("./lib/workflow-core-config");

function main() {
	if (guardDisabled(path.basename(__filename), { root: hostRoot() })) return;
	if (!isFounderTyping(hookMessage.readPayload())) return;
	markPresent(new Date());
}

try {
	main();
} catch {
	/* Fail open (#2004). */
}
