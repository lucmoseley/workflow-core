/*
 * held-unit.js — an unfinished build unit: an open `kind:ticket` with an
 * unticked, unwaived criterion (lib/ticket-criteria.js) and no `parked` label
 * (#4535, on #4495's ruling). session-arbiter.js's `release-issue` refuses to
 * drop the claim on one, and guard-held-ticket.js refuses a session-ending
 * turn while one is claimed, so neither the claim nor the session lets go of
 * the unit before its close.
 *
 * A unit's boundary is set at filing by the size line (`rule:size-line`) and
 * nothing else moves it: no ticket comment or body note.
 *
 * THE RELEASE BINDS ONLY ON A UNIT THIS SESSION HAS STARTED — one its own
 * commit cites — so a bundle's unstarted members, claimed at dispatch, are
 * still released at a member boundary (pick-next's §Bundles). Residual: a
 * session that never committed on its unit releases it unrefused, and the
 * Stop guard still holds it while it is claimed.
 */

const fs = require("node:fs");
const path = require("node:path");
const { ghJson } = require("./gh");
const { markersDir } = require("./marker-root");
const { PARKED_LABEL } = require("./parked");
const { scriptPath } = require("./script-path");
const { unmetCriteria } = require("./ticket-criteria");

const KIND_TICKET = "kind:ticket";

/* The four exits #4495 names, in both refusals' text. */
const EXITS = `\`${scriptPath("park-blocked.sh")} <n> takes:wayfinder|waiting:external|keep "<why>"\` for a ticket blocked on the founder or an outside party; a \`needs input:\` park with its \`**Hand-off:**\` block; the 300,000 tripwire; or the compaction backstop's hand-off`;

/**
 * Whether `issue`, as the REST API reads it, is an unfinished build unit.
 * @param {{state?: string, labels?: ({name: string}|string)[], body?: string|null}} issue
 */
function isUnfinishedUnit(issue) {
	const labels = (issue.labels ?? []).map((l) =>
		typeof l === "string" ? l : l.name,
	);
	return (
		issue.state === "open" &&
		labels.includes(KIND_TICKET) &&
		!labels.includes(PARKED_LABEL) &&
		unmetCriteria(issue.body).length > 0
	);
}

/**
 * Whether issue `n` in `tracker` is an unfinished build unit. Throws on a
 * read error.
 * @param {string} tracker
 * @param {number} n
 * @param {{timeout: number}} opts
 */
function readUnfinishedUnit(tracker, n, opts) {
	return isUnfinishedUnit(
		ghJson(["api", `repos/${tracker}/issues/${n}`], opts),
	);
}

/**
 * The issue park-blocked.sh's `.parked-blocked-<sid>` record names, or null
 * where none reads. park-blocked.sh writes it before it releases the claim.
 * @param {string} sid
 * @param {string} [root]
 * @returns {number|null}
 */
function parkedBlockedIssue(sid, root) {
	try {
		const rec = JSON.parse(
			fs.readFileSync(
				path.join(markersDir(root), `.parked-blocked-${sid}`),
				"utf8",
			),
		);
		return Number.isInteger(rec?.issue) ? rec.issue : null;
	} catch {
		return null;
	}
}

/**
 * Whether a commit in `sid`'s commit ledger cites `#n` in its message. False
 * where the ledger or git will not read.
 * @param {string} sid
 * @param {number} n
 */
function citedByOwnCommit(sid, n) {
	const commits = require("./arbiter-store").readCommitsBy(sid);
	if (!commits || commits.length === 0) return false;
	const log = require("./arbiter-core").gitIn(
		["log", "--no-walk=unsorted", "--stdin", "--format=%B"],
		`${commits.join("\n")}\n`,
	);
	return log !== null && new RegExp(`#${n}(?!\\d)`).test(log);
}

module.exports = {
	citedByOwnCommit,
	EXITS,
	isUnfinishedUnit,
	parkedBlockedIssue,
	readUnfinishedUnit,
};
