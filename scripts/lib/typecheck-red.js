/*
 * typecheck-red.js — the PostToolUse dispatcher core on Bash that tells a
 * session its commit's pre-commit type-check ran RED (#3824).
 *
 * THE FAULT. The hook's type-check never blocks (mantahostels#1062) and reports
 * to the commit's stderr, which sessions pipe, so a RED try can leave its first
 * heard report to CI.
 *
 * THE ROUTE. .husky/pre-commit hands a RED try's output to
 * scripts/record-typecheck-red.js, which writes one record for the session
 * (lib/typecheck-red-host.js). This core takes it on the session's next Bash
 * answer, a foreground commit's own included.
 * guard-typecheck-owed.js takes one still unheard at Stop: a commit run in the
 * background whose turn ends with no further Bash call.
 *
 * LIMITS
 *  - A commit with no session id records nothing.
 *  - A newer RED try replaces an unheard one, and a green try clears nothing, so
 *    a background commit's report may be older than the tree. The text asks for
 *    a re-run on a still tree before it is believed.
 *  - A subagent's Bash answer takes nothing, as a subagent shares its parent's
 *    session id and could swallow the report, so a subagent's own commit is
 *    told to the main thread.
 *  - A commit in another repository records under that repository's checkout,
 *    which this core does not read, so it goes unheard.
 *  - guard-typecheck-owed.js's three blocks are one cap across its two findings:
 *    past it a record waits for a Bash answer, and held tries go unasked.
 *  - A declared command that exits 75 is read as a held slot by the hook, and
 *    records nothing.
 *
 * FAILS OPEN (mantahostels#103 §6): no session id or an unreadable record says
 * nothing.
 *
 * IMPLICIT: after a Bash call, hands the session the output of its commit's RED
 *   pre-commit type-check, once, deleting the record.
 * JUSTIFIED: fail-safe — it adds context and refuses nothing; without it a type
 *   error waits for the landing push's CI result.
 * DEFEAT: listing `guard-typecheck-red` under the host's `disabled` silences the
 *   core; guard-typecheck-owed.js still takes the record at Stop.
 */

/**
 * @typedef {{ at: string, command: string, output: string, cut: boolean }} RedTry
 * @typedef {(sid: string) => RedTry | null} TakeRed removes and returns the
 *   session's record, or null where it has none
 */

/**
 * @param {RedTry} red
 * @returns {string}
 */
function redReport({ at, command, output, cut }) {
	return `Your commit's pre-commit type-check ran RED at ${at}, which this gate reports and does not block on: \`${command}\` said
${output}${cut ? "\n… cut here; the command prints the rest." : ""}
In this shared tree an error may be a parallel session's half-written file. Re-run \`${command}\` on a still tree before believing it, and fix any error your work caused: ci.yml's Typecheck step is the gate.`;
}

/**
 * @param {string} _command
 * @param {import("./guard-dispatch.js").CoreContext & { takeRed: TakeRed }} ctx
 */
function decide(_command, ctx) {
	if (!ctx.session || ctx.agent) return null;
	const red = ctx.takeRed(ctx.session);
	return red ? { context: redReport(red) } : null;
}

module.exports = {
	field: "command",
	noun: "type-check report",
	decide,
	redReport,
};
