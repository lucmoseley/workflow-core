const { ALARM_NAMES } = require("./queue-alarms.js");

const NOT_A_TREE_VERDICT = new Set([
	"bisect",
	"Dependency Graph",
	"issue-card-drift",
	"Named rerun",
	"Warm caches",
	...ALARM_NAMES,
]);

/** @param {{conclusion?: string|null}} r */
const hasVerdict = (r) => Boolean(r.conclusion);

/**
 * @template {{headSha?: string, conclusion?: string|null, workflowName?: string}} R
 * @param {R[]} runs
 * @returns {R[]}
 */
function newestVerdictRuns(runs) {
	const judged = runs.filter(
		(r) =>
			hasVerdict(r) &&
			r.headSha &&
			!NOT_A_TREE_VERDICT.has(r.workflowName ?? ""),
	);
	const sha = judged[0]?.headSha;
	return judged.filter((r) => r.headSha === sha);
}

module.exports = { NOT_A_TREE_VERDICT, hasVerdict, newestVerdictRuns };
