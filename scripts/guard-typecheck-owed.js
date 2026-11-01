#!/usr/bin/env node
/*
 * guard-typecheck-owed.js — Stop hook. Asks a session for a type-check where
 * its commit's pre-commit try found the machine-wide slot held (#3803).
 *
 * WHY. The hook never waits for the slot, as its commit holds .git/index.lock
 * (#3278), so a held slot leaves that commit's first type report to CI, and the
 * hook's skip line goes to commit output that sessions usually pipe through
 * `tail` or `grep`.
 *
 * THE DEBT IS READ OFF queue-run.js's EXIT LOG (lib/queue-exit-log.js), so paying
 * it writes nothing here. A `refused` line marked `noWait` is a held try; an
 * `opened` line with no `noWait` is a later run of the session's own. A later
 * try that opened pays nothing, as its report goes to the same piped output.
 *
 * WHY THE MODEL RUNS IT. The check outlasts this hook's timeout and may wait in
 * the queue, so the block hands over the command.
 *
 * IT ALSO TAKES A RED TRY STILL UNHEARD (#3824): lib/typecheck-red.js delivers one
 * on the next Bash answer, so what reaches here is a background commit whose turn
 * ends with no further Bash call.
 *
 * LIMITS. `opened` is written before the command starts, and nothing records a
 * run's end, so a run killed after it reads as paid. A try whose commit another
 * gate then refused still owes, and so does a commit behind the session's own
 * background type-check, which costs one more run.
 *
 * IMPLICIT:  reads the queue exit log at every Stop, and blocks the turn when
 *            this session has a held try and no own run after it, or an unheard
 *            RED record, which it deletes.
 * JUSTIFIED: fail-safe — a type error otherwise waits for the landing push's CI
 *            result, and the command it asks for only reports.
 * DEFEAT:    at most three blocks a session; a held try is silent with no log
 *            or no declared command; silent on every failure path. A commit
 *            made with no session id is in no session's lines and leaves no
 *            record.
 */

const { logger } = require("./lib/entry-input.js");
const hookBlock = require("./lib/hook-block");
const { readJsonl } = require("./lib/jsonl.js");
const { queueExitLogPath } = require("./lib/queue-exit-log");
const stopGuard = require("./lib/stop-guard");
const { redReport } = require("./lib/typecheck-red.js");
const { takeRed } = require("./lib/typecheck-red-host.js");
const { readCommandOrDefault } = require("./lib/workflow-core-config.js");

/**
 * When this session's oldest held try since its last own run happened, or null
 * where it owes nothing.
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
	/* At the cap the block is refused, so the record stays for the next Bash. */
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
	const command = readCommandOrDefault("typecheck", { root });
	if (!file || !command) return null;
	const since = readOwedSince(file, sid);
	if (since === null) return null;
	return (
		`A commit's pre-commit type-check found the slot held at ${since} and did not run, and this session has run none of its own since. ` +
		`Run \`${command}\` now: it waits for the slot and holds no lock. ` +
		"Fix any error your work caused; in this shared tree one may be a parallel session's half-written file."
	);
}

if (require.main === module) stopGuard.onPayload({ review: judge });
