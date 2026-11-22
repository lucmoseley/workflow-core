const { readCommitsBy } = require("./arbiter-store");
const { gitIn } = require("./arbiter-core");
const { ghJson } = require("./gh");
const { isGateHolding } = require("./issue-gate");
const { PARKED_LABEL } = require("./parked");
const { scriptPath } = require("./script-path");
const { TRIPWIRE } = require("./session-tripwire");
const { unmetCriteria } = require("./ticket-criteria");

const KIND_TICKET = "kind:ticket";

const UNFINISHED =
	"an open `kind:ticket` with an unticked, unwaived acceptance criterion, no `parked` label and no holding gate line";

const EXITS = `\`${scriptPath("park-blocked.sh")} <n> takes:wayfinder|waiting:external|keep "<why>"\` for a ticket blocked on the founder or an outside party; a \`needs input:\` park with its \`**Hand-off:**\` block; the ${TRIPWIRE.toLocaleString("en-GB")} tripwire; or the compaction backstop's hand-off`;

/**
 * @param {{state?: string, labels?: ({name: string}|string)[], body?: string|null}} issue
 */
function isUnfinishedUnit(issue) {
	const labels = (issue.labels ?? []).map((l) =>
		typeof l === "string" ? l : l.name,
	);
	if (
		issue.state !== "open" ||
		!labels.includes(KIND_TICKET) ||
		labels.includes(PARKED_LABEL) ||
		unmetCriteria(issue.body).length === 0
	)
		return false;
	return !isGateHolding(issue.body ?? "");
}

/**
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
	UNFINISHED,
	isCitedByOwnCommit,
	isUnfinishedUnit,
	isUnfinishedUnitIn,
};
