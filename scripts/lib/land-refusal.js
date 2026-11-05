/*
 * land-refusal.js — the line lib/session-checkout.js throws where a
 * neighbour's push beat a land's own (#4446), and that
 * lib/worktree-model-reading.js reads transcripts for, from one place.
 */

const MOVED_LINE =
	"landing moved after the fetch: a neighbour pushed first — land again, which merges the newer origin/landing into HEAD and pushes";

module.exports = { MOVED_LINE };
