/*
 * land-refusal.js — git's words for a push refused because the remote ref
 * holds a commit ours lacks, which lib/session-checkout.js tests a land's
 * push for and lib/divergence-row.js files a row on, and the line the land
 * throws for it (#4446, #4458), which lib/worktree-model-reading.js reads
 * transcripts for. Only the session writes its queue ref, so the ref holding
 * a commit HEAD lacks means HEAD was rewritten after a push.
 */

const REJECTED = "[rejected]";
const FETCH_FIRST = "fetch first";
const NON_FAST_FORWARD = "non-fast-forward";

/** A push's ref line refused for either reason. */
const MOVED = new RegExp(
	`${REJECTED.replace(/[[\]]/g, "\\$&")}[^\\n]*\\((?:${FETCH_FIRST}|${NON_FAST_FORWARD})\\)`,
);

const MOVED_LINE =
	"the push is no fast-forward: your queue ref holds a commit HEAD lacks, so HEAD was rewritten after a push";

module.exports = {
	FETCH_FIRST,
	MOVED,
	MOVED_LINE,
	NON_FAST_FORWARD,
	REJECTED,
};
