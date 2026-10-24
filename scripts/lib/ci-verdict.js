/*
 * ci-verdict.js — which runs on the branch carry `main`'s verdict, shared by
 * scripts/check-ci-status.js and the delivery script's CI re-check gate (#856).
 *
 * THE GATE IS COARSER THAN THE CHECK, deliberately. It keys on the set the
 * check judges red from, and leaves the check's own narrowing — superseded cancellations, the denylist
 * fallback — to the full check the gate runs. A move the check would ignore
 * costs one full check; none it would report goes unseen.
 */

/* Workflows whose red or green says nothing about whether `main` is healthy, so
 * none of them may become the run this keys on. A denylist: a workflow added
 * later counts as verifying and so surfaces, rather than being ignored.
 *
 * `bisect` is the one that bites. It is dispatch-only, but firing the very
 * bisect check-ci-status.js's report recommends creates a newer run at a newer
 * sha, which would then mask the red that prompted it. `issue-card-drift` has
 * no workflow file (#1557), but GitHub still lists its past runs, which judge
 * the tracker, not the tree. */
const NOT_A_TREE_VERDICT = new Set([
	"bisect",
	"Dependency Graph",
	"issue-card-drift",
]);

/* A run has FINISHED when it has a conclusion — never when `status` says so.
 * `status` can read `in_progress` long after every job has finished
 * (docs/agents/issue-tracker.md §Running `gh` at all), so a filter on it drops
 * the very run that report exists for and silently falls back to an older,
 * greener one. */
/** @param {{conclusion?: string|null}} r */
const hasVerdict = (r) => Boolean(r.conclusion);

/**
 * Every finished, verifying run at the sha of the newest one (gh's
 * newest-first order); empty where none has finished.
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
