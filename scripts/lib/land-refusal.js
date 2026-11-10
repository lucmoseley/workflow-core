/*
 * land-refusal.js — the test lib/session-checkout.js runs on a land's push
 * output for a push refused as no fast-forward, built from
 * lib/divergence-row.js's git words so the two read one spelling (workflow-core#4703),
 * and the line the land throws for it (workflow-core#4446, workflow-core#4458), which
 * lib/worktree-model-reading.js reads transcripts for. Only the session
 * writes its queue ref, so the ref holding a commit HEAD lacks means HEAD was
 * rewritten after a push.
 */

const {
	FETCH_FIRST,
	NON_FAST_FORWARD,
	REJECTED,
} = require("./divergence-row.js");
const { escapeRe } = require("./regex-group.js");

/** A push's ref line refused for either reason. */
const MOVED = new RegExp(
	`${escapeRe(REJECTED)}[^\\n]*\\((?:${escapeRe(FETCH_FIRST)}|${escapeRe(NON_FAST_FORWARD)})\\)`,
);

const MOVED_LINE =
	"the push is no fast-forward: your queue ref holds a commit HEAD lacks, so HEAD was rewritten after a push";

module.exports = { MOVED, MOVED_LINE };
