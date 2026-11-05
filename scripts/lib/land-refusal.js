/*
 * land-refusal.js — the line lib/session-checkout.js throws where a
 * neighbour's push beat a land's own (#4446), and that
 * lib/worktree-model-reading.js reads transcripts for, from one place.
 */

const { branchOf, pushedRefFor } = require("./landing-refs.js");

/* A land runs with the `landing` module on. */
const PUSHED = pushedRefFor(true);

const MOVED_LINE = `${branchOf(PUSHED)} moved after the fetch: a neighbour pushed first — land again, which merges the newer ${PUSHED} into HEAD and pushes`;

module.exports = { MOVED_LINE };
