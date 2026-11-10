#!/usr/bin/env node
/*
 * mark-presence.js — UserPromptSubmit hook. Records that the founder typed a
 * prompt, so the refill loop can tell present from away (#2004, spec #1995),
 * and reminds him that away mode is on at his first prompt back (#4846).
 *
 * What is not his typing is lib/founder-typing.js's to say.
 *
 * THE REMINDER: away mode changes only by his hand, so a prompt switches
 * nothing. It is owed where a tick has read him absent since the away switch
 * and the prompt before this one is older than the presence window: once per
 * absence, as his next prompt finds this one inside the window.
 *
 * BLIND SPOT: a session whose repo does not run this plugin writes nothing,
 * so a prompt typed there reads him as away and shows no reminder.
 *
 * IN NO §N3 FAMILY: it refuses nothing and checks nothing — it writes a
 * marker.
 *
 * FAILS OPEN: never blocks the prompt, and a reminder it cannot work out is
 * not shown.
 *
 * IMPLICIT:  at every prompt typed in an interactive session, into a running background job or as an agents-view launch, writes the time and the typing session's seat to `~/.claude/.founder-presence`; at his first prompt after a tick read him absent in away mode, prints a `systemMessage` reminding him to run `set --normal`.
 * JUSTIFIED: fail-safe — a missed prompt reads him as away (#1995).
 * DEFEAT:    none needed — it never blocks; `disabled` in .claude/workflow-core.json stands it down.
 * TREE:      host — stamps machine-wide founder presence under the host root's config switch
 */

const path = require("node:path");
const { isFounderTyping } = require("./lib/founder-typing");
const hookMessage = require("./lib/hook-message");
const { hostRoot } = require("./lib/host-root");
const { markPresent, presenceAt, readLastTypedAt } = require("./lib/presence");
const { guardDisabled } = require("./lib/workflow-core-config");

/**
 * Whether a prompt typed at `now` is his first since a tick read him absent in
 * away mode.
 * @param {Date} now
 */
function isReminderOwed(now) {
	try {
		if (presenceAt(readLastTypedAt(), now) === "present") return false;
		/* Required here: only a first prompt back pays its load. */
		const { readControlFile } = require("./lib/refill-files.js");
		const control = readControlFile(() => undefined);
		return control?.scope.mode === "away" && control.away?.absentSeen === true;
	} catch {
		return false;
	}
}

function main() {
	if (guardDisabled(path.basename(__filename), { root: hostRoot() })) return;
	if (!isFounderTyping(hookMessage.readPayload())) return;
	const now = new Date();
	const owed = isReminderOwed(now);
	markPresent(now);
	if (!owed) return;
	const { scriptPath } = require("./lib/script-path.js");
	process.stdout.write(
		JSON.stringify({
			systemMessage: `away mode is on — run \`node ${scriptPath("refill-loop.js")} set --normal\``,
		}),
	);
}

try {
	main();
} catch {
	/* Fail open (#2004). */
}
