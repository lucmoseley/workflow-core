/**
 * @typedef {object} ShellGuardPorts
 * @property {(script: string, payload: Record<string, unknown>) => string} runShellGuard
 * @typedef {import("./kit-context.js").KitContext & ShellGuardPorts} ShellGuardContext
 */

/** @param {ShellGuardContext} ctx */
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
