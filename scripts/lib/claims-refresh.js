/*
 * claims-refresh.js — the PostToolUse dispatcher core that re-records what
 * this session's claimed files hold after a Bash call, because a shell command
 * may have written any of them and no other hook sees it (mantahostels#295).
 *
 * Without it, a session's own version-stamp `sed -i` on a file it holds
 * reports at its next write as a clobber by an unwatched route — the very
 * class the detector exists to name (the measured share is in
 * mantahostels#288).
 *
 * IT READS BYTES, NEVER THE COMMAND. Parsing a shell command for its write
 * targets is the arms race mantahostels#287 declined. So it refreshes what the
 * session holds, and scans the watched tiers (mantahostels#419), baselining
 * whatever moved since this session's own last call. The scan is what covers a
 * session that reached the file only from Bash and so holds no claim to
 * refresh. It mints a baseline and a recovery pin, never a lock: a scan sees
 * that bytes changed, not who changed them, so a claim from one would block a
 * neighbour on an inference.
 *
 * A recorder, not a guard: it says nothing, and fails open.
 *
 * LIMITS
 *  - A hang inside the store (mkdirSync(recursive) under an unreadable path
 *    blocks on this kernel) is bounded by the dispatcher entry's timeout, not
 *    a timeout of its own, and costs the other cores of that call their say.
 */

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
