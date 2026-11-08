/*
 * land-refusal.js — the line lib/session-checkout.js throws where a land's
 * push to its queue ref is no fast-forward (workflow-core#4446, workflow-core#4458), and that
 * lib/worktree-model-reading.js reads transcripts for, from one place. Only
 * the session writes its queue ref, so the ref holding a commit HEAD lacks
 * means HEAD was rewritten after a push.
 */

const MOVED_LINE =
	"the push is no fast-forward: your queue ref holds a commit HEAD lacks, so HEAD was rewritten after a push";

module.exports = { MOVED_LINE };
