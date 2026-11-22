#!/usr/bin/env node
const { logger } = require("./lib/entry-input.js");
const hookBlock = require("./lib/hook-block");
const { readJsonl } = require("./lib/jsonl.js");
const { queueExitLogPath } = require("./lib/queue-exit-log");
const stopGuard = require("./lib/stop-guard");
const { redReport } = require("./lib/typecheck-red.js");
const { takeRed } = require("./lib/typecheck-red-host.js");
const { readDeclaredCommand } = require("./lib/workflow-core-config.js");

/**
 * @param {string} file
 * @param {string} sid
 * @returns {string|null}
 */
function readOwedSince(file, sid) {
	const rows =
		readJsonl(file, (line) => line.includes('"kind":"tsc"'))?.rows ?? [];
	/** @type {string|null} */
	let since = null;
	for (const { session, reason, noWait, at } of rows) {
		if (session !== sid) continue;
		if (reason === "opened" && !noWait) since = null;
		else if (reason === "refused" && noWait) since ??= String(at);
	}
	return since;
}

/**
 * @param {{sessionId: string, root: string}} ctx
 */
function judge({ sessionId: sid, root }) {
	const finding = redFinding(root, sid) ?? heldFinding(root, sid);
	if (!finding) return;
	hookBlock.blockStop({
		prefix: ".typecheck-owed-nagged-",
		sessionId: sid,
		reason: `${finding} Then re-send the message this turn was going to end on, its status marker included — this block discarded it.`,
	});
}

/**
 * @param {string} root
 * @param {string} sid
 * @returns {string|null}
 */
function redFinding(root, sid) {
	// #3824
	if (hookBlock.capSpent({ prefix: ".typecheck-owed-nagged-", sessionId: sid }))
		return null;
	const red = takeRed(root, sid, logger("guard-typecheck-owed.js", root));
	return red && redReport(red);
}

/**
 * @param {string} root
 * @param {string} sid
 * @returns {string|null}
 */
function heldFinding(root, sid) {
	const file = queueExitLogPath(root);
	const command = readDeclaredCommand("typecheck", { root });
	if (!file || !command) return null;
	const since = readOwedSince(file, sid);
	if (since === null) return null;
	return (
		`A commit's pre-commit type-check found the slot held at ${since} and did not run, and this session has run none of its own since. ` +
		`Run \`${command}\` now: it waits for the slot and holds no lock. ` +
		"Fix any error your work caused; one may be a file saved while it ran."
	);
}

if (require.main === module) stopGuard.onPayload({ review: judge });
