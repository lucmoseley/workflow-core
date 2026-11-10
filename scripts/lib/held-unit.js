/*
 * held-unit.js — an unfinished build unit: an open `kind:ticket` with an
 * unticked, unwaived criterion (lib/ticket-criteria.js) and no `parked` label.
 * session-arbiter.js's `release-issue` refuses to drop the claim on one, and
 * guard-held-ticket.js refuses a session-ending turn while one is claimed.
 *
 * A unit's boundary is set at filing by the size line (`rule:size-line`) and
 * nothing else moves it: no ticket comment or body note.
 *
 * THE RELEASE BINDS ONLY ON A UNIT THIS SESSION HAS STARTED — one its own
 * commit cites — so a bundle's unstarted members, claimed at dispatch, are
 * still released at a member boundary (pick-next's §Bundles). Residual: a
 * session that never committed on its unit releases it unrefused, as does a
 * refill resume's copy holding a moved claim until it commits under its own
 * id, since the commit ledger is keyed by session; the Stop guard still holds
 * either while it is claimed.
 */

const { readCommitsBy } = require("./arbiter-store");
const { gitIn } = require("./arbiter-core");
const { ghJson } = require("./gh");
const { PARKED_LABEL } = require("./parked");
const { scriptPath } = require("./script-path");
const { TRIPWIRE } = require("./session-tripwire");
const { unmetCriteria } = require("./ticket-criteria");

const KIND_TICKET = "kind:ticket";

const EXITS = `\`${scriptPath("park-blocked.sh")} <n> takes:wayfinder|waiting:external|keep "<why>"\` for a ticket blocked on the founder or an outside party; a \`needs input:\` park with its \`**Hand-off:**\` block; the ${TRIPWIRE.toLocaleString("en-GB")} tripwire; or the compaction backstop's hand-off`;

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
function isUnfinishedUnitIn(tracker, n, opts) {
	return isUnfinishedUnit(
		ghJson(["api", `repos/${tracker}/issues/${n}`], opts),
	);
}

/**
 * Whether a commit in `sid`'s commit ledger cites `#n` in its message — this
 * repo's `#n`, not another's `owner/repo#n` or `repo#n`. False where the
 * ledger or git will not read.
 * @param {string} sid
 * @param {number} n
 */
function isCitedByOwnCommit(sid, n) {
	const commits = readCommitsBy(sid);
	if (!commits || commits.length === 0) return false;
	const log = gitIn(
		["log", "--no-walk=unsorted", "--stdin", "--format=%B"],
		`${commits.join("\n")}\n`,
	);
	return log !== null && new RegExp(`(?<![\\w/.-])#${n}(?!\\d)`).test(log);
}

module.exports = {
	EXITS,
	isCitedByOwnCommit,
	isUnfinishedUnit,
	isUnfinishedUnitIn,
};
