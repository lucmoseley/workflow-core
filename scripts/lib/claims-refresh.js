/**
 * @param {string} _command
 * @param {{ session: string, env: Record<string, string | undefined>,
 *   refreshClaims: (session: string) => void }} ctx
 */
function decide(_command, ctx) {
	const session = ctx.session || ctx.env.CLAUDE_CODE_SESSION_ID;
	if (session) ctx.refreshClaims(session);
	return null;
}

module.exports = { field: "command", noun: "claim refresh", decide };
