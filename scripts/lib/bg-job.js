/*
 * bg-job.js — the dispatcher core that hands a session the killed-background-
 * job rule BEFORE it backgrounds anything (mantahostels#1904, under
 * mantahostels#1900).
 *
 * LIMITS
 *  - INJECTION ONLY: it never refuses.
 *  - It reads the Bash tool's own flag and nothing else. A job backgrounded
 *    any other way sets no flag and is not seen: a `&` inside the command,
 *    `nohup`, a script that daemonises, and — deliberately — the harness
 *    backgrounding a foreground call itself after its 600 s timeout.
 *  - A `git push` carrying the flag also fires the guard-push-rules core, so one
 *    call can carry four ids, each capped per hook entry (mantahostels#2004,
 *    mantahostels#2046).
 */

/**
 * Only a literal `true` backgrounds: a command whose text mentions the flag is not one.
 * @param {string} _command
 * @param {import("./guard-dispatch.js").CoreContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(_command, ctx) {
	if (ctx.input.run_in_background !== true) return null;
	return { injectRules: ["killed-background-job"] };
}

module.exports = { field: "command", noun: "background job", decide };
