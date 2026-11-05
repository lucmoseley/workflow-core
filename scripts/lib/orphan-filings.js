/*
 * orphan-filings.js — where check-orphaned-edits.js records each triage
 * filing, and how the reaper (lib/session-checkout.js) finds a worktree's.
 *
 * A marker per filing in `orphaned-edits-filed/` under the git common dir,
 * which every worktree shares. A linked worktree's marker is named
 * `wt-<worktree key>-<state key>.json`, so its filings are found by the
 * worktree alone (#4439): the reaper names the issue rather than flagging the
 * worktree a second time.
 */

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const FILED_DIR = "orphaned-edits-filed";

/** @param {string} s */
const hashOf = (s) => createHash("sha256").update(s).digest("hex");

/** @param {string} label the worktree as `worktreeLabel` names it */
const worktreePrefix = (label) => `wt-${hashOf(label).slice(0, 16)}-`;

/**
 * The marker file name for one filing.
 * @param {{worktree: string|null, state: string}} unit `state` the text the
 *   filing is keyed by: the path and blob of a main-checkout file, or every
 *   orphaned file's of a worktree
 */
function markerName({ worktree, state }) {
	if (worktree === null) return `${hashOf(state).slice(0, 32)}.json`;
	return `${worktreePrefix(worktree)}${hashOf(state).slice(0, 16)}.json`;
}

/**
 * A short tag for a filing's state, for its issue title.
 * @param {{state: string}} unit
 */
const stateTag = ({ state }) => hashOf(state).slice(0, 10);

/**
 * The issue last filed for worktree `label`, or null where none was recorded.
 * @param {string} commonDir
 * @param {string} label
 * @returns {string|null}
 */
function readWorktreeFiling(commonDir, label) {
	const dir = path.join(commonDir, FILED_DIR);
	const prefix = worktreePrefix(label);
	let names;
	try {
		names = fs.readdirSync(dir).filter((n) => n.startsWith(prefix));
	} catch {
		return null;
	}
	let best = { at: -1, ref: /** @type {string|null} */ (null) };
	for (const n of names) {
		try {
			const { ref, at } = JSON.parse(
				fs.readFileSync(path.join(dir, n), "utf8"),
			);
			if (ref && Number(at) > best.at) best = { at: Number(at), ref };
		} catch {
			// Empty or torn: a filing running or killed, which names no issue.
		}
	}
	return best.ref;
}

module.exports = { FILED_DIR, markerName, readWorktreeFiling, stateTag };
