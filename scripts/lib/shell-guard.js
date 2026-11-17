/*
 * shell-guard.js — what the dispatcher cores share that run a shell guard the
 * founder's machine also runs on its own (#5384, #5389): each core tests its
 * trigger in process and starts the script only on a hit, so a call that
 * names none starts no process beyond the dispatcher (base §G13 (2)). The
 * scripts stay shell, byte-equal to the machine copies `npm run
 * check:settings` holds them to.
 */

/**
 * @typedef {object} ShellGuardPorts
 * @property {(script: string, payload: Record<string, unknown>) => string} runShellGuard
 *   the script under scripts/ run on `payload` as its stdin, its stdout;
 *   throws where it cannot start, times out or exits non-zero
 * @typedef {import("./kit-context.js").KitContext & ShellGuardPorts} ShellGuardContext
 */

/**
 * The hook payload a PreToolUse shell guard reads, rebuilt from the kit's.
 * @param {ShellGuardContext} ctx
 */
function payloadFor(ctx) {
	return {
		hook_event_name: "PreToolUse",
		session_id: ctx.key?.sid ?? "",
		...(ctx.agent ? { agent_id: ctx.agent } : {}),
		tool_name: ctx.tool,
		tool_input: ctx.input,
		...(ctx.cwd ? { cwd: ctx.cwd } : {}),
	};
}

/**
 * A shell guard's hook answer as a decision: a deny, a context, or null for
 * silence. Output that is not the hook JSON throws, so the row's failure
 * policy rules on it.
 * @param {string} stdout
 * @returns {import("./guard-entry.js").Decision}
 */
function relay(stdout) {
	if (!stdout.trim()) return null;
	const out = JSON.parse(stdout).hookSpecificOutput ?? {};
	if (out.permissionDecision === "deny")
		return { deny: String(out.permissionDecisionReason) };
	if (typeof out.additionalContext === "string")
		return { context: out.additionalContext };
	return null;
}

/**
 * Run `script` where `trigger` admits `subject`, relaying its answer.
 * @param {string} script
 * @param {RegExp} trigger
 * @param {string} subject
 * @param {ShellGuardContext} ctx
 */
function runOnTrigger(script, trigger, subject, ctx) {
	if (!trigger.test(subject)) return null;
	return relay(ctx.runShellGuard(script, payloadFor(ctx)));
}

module.exports = { runOnTrigger };
