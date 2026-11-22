const path = require("node:path");
const { ignoreFailure } = require("./caught.js");
const { repoRoot } = require("./hook-block");
const { markersDir } = require("./marker-root");
const { readSeen, writeSeen } = require("./report-once");
const { buildLineRe } = require("./marker-line");

const COMPACTIONS_PREFIX = ".session-ceiling-compactions-";
const PENDING_PREFIX = "pending:";

/** @param {string} sid */
const compactionSetFile = (sid) =>
	path.join(markersDir(repoRoot()), COMPACTIONS_PREFIX + sid);

/**
 * @param {string} sid
 * @param {string[]} keys
 * @returns {number}
 */
function recordCompactions(sid, keys) {
	const file = compactionSetFile(sid);
	const seen = readSeen(file);
	const before = [...seen].join("\n");
	for (const key of seen) if (key.startsWith(PENDING_PREFIX)) seen.delete(key);
	for (const key of keys) seen.add(key);
	if ([...seen].join("\n") !== before && !writeSeen(file, seen)) {
		ignoreFailure(() =>
			require("./arbiter-core").logError(
				"compaction-set",
				new Error(`unwritable: ${file}`),
			),
		);
	}
	return seen.size;
}

/** @param {string} sid */
function countCompactions(sid) {
	return readSeen(compactionSetFile(sid)).size;
}

const COMPACTIONS_MARKER = "Compactions";
/** @param {number} count @param {string} sid */
const buildCompactionsLine = (count, sid) =>
	`**${COMPACTIONS_MARKER}:** ${count} (session ${sid})`;
const COMPACTIONS_LINE_RE = buildLineRe(
	COMPACTIONS_MARKER,
	"(\\d+)(?:[ \\t]+\\(session ([^)\\s]+)\\))?",
	"gm",
	"(?:[-*+][ \\t]+)?`?",
);
/** @param {string} comment @param {string} sid */
const hasSessionCompactionsLine = (comment, sid) =>
	[...comment.matchAll(COMPACTIONS_LINE_RE)].some((m) => m[2] === sid);

/** @param {number} count */
function buildCompactionSentence(count) {
	const times = `${count.toLocaleString("en-GB")} time${count === 1 ? "" : "s"}`;
	return `This session has autocompacted ${times}.`;
}

// guess, #4380
const COMPACTION_BACKSTOP = 10;

/**
 * @param {number} count
 * @param {{issue: number|null, stateFile: string|null}} unit
 * @param {string} sid
 */
function compactionAdvice(count, { issue, stateFile }, sid) {
	const theIssue = issue ? `issue #${issue}` : "the issue you are working";
	if (count >= COMPACTION_BACKSTOP) {
		const update = stateFile
			? `, update the build state file ${stateFile}`
			: "";
		return `That is the backstop (${COMPACTION_BACKSTOP}): commit what exists${update}, comment the unfinished state on ${theIssue} with a \`${buildCompactionsLine(count, sid)}\` line, leave it open, and end.`;
	}
	const state = stateFile ? `the build state file ${stateFile}, ` : "";
	return `Re-read ${state}${theIssue}, and \`git log\` and \`git diff\` of your own commits on it; where the compaction summary disagrees with them, the summary is only a hint. Carry on with the unit in flight, and start no new unit after it.`;
}

module.exports = {
	PENDING_PREFIX,
	recordCompactions,
	buildCompactionSentence,
	COMPACTION_BACKSTOP,
	compactionAdvice,
	countCompactions,
	COMPACTIONS_MARKER,
	COMPACTIONS_LINE_RE,
	buildCompactionsLine,
	hasSessionCompactionsLine,
};
