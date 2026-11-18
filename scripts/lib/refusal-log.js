/*
 * refusal-log.js — the writer of the priced-options guard's refusal-limb logs
 * (workflow-core#1753): the close-check log (`close-check-log.js`, workflow-core#1101) and the
 * round-check log (`round-check.js`, workflow-core#1710). A file of its own, loaded only
 * inside the limb's try, so one that will not load costs a logged line, never
 * the guard (workflow-core#1747).
 *
 * THE STORES sit under names no sweep family claims, so they outlive the 24 h
 * marker sweep, and apart from the per-session refusal records, which are
 * deleted when a question passes. Append-only and unbounded — a few hundred
 * bytes a question — so nothing rewrites, rotates or prunes them.
 *
 * The writer throws; refusal-limb.js catches, logs to the fail-open log and
 * the limb keeps its decision. Exported for the reporters and their test
 * fixtures, so producer and reader share one format.
 */

const fs = require("node:fs");
const path = require("node:path");
const { markersDir } = require("./marker-root.js");

/**
 * @param {string} root the host repo root
 * @param {string} store the log's file name in the markers directory
 * @returns {string}
 */
const logPath = (root, store) => path.join(markersDir(root), store);

/**
 * Append one line per event, `at` defaulting to now and `repo` to the root's
 * name.
 * @template {{ at?: string, session: string, round: string, kind: string }} E
 * @param {string} root the host repo root
 * @param {E[]} events
 * @param {string} store the log's file name in the markers directory
 */
function appendEvents(root, events, store) {
	if (events.length === 0) return;
	const repo = path.basename(root);
	const now = new Date().toISOString();
	const lines = events.map(({ at = now, session, round, kind, ...rest }) =>
		JSON.stringify({ at, session, repo, round, kind, ...rest }),
	);
	fs.appendFileSync(logPath(root, store), `${lines.join("\n")}\n`);
}

module.exports = { logPath, appendEvents };
