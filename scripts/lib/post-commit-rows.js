/*
 * post-commit-rows.js — .husky/post-commit's Node steps, one row each, run
 * in order by scripts/post-commit-dispatch.js through
 * lib/precommit-dispatch.js (#5207). Every row warns: git ignores the hook's
 * exit status, and a step's fault must never read as a failed commit.
 *
 * A rebase, cherry-pick or multi-commit revert replays commits, firing this
 * hook once per replayed commit, and a bisect checks out commits nobody here
 * wrote. The route-gated rows stand down on those routes, lib/commit-route.js's
 * `post-commit-stand-down` set, each for a reason of its own: the three
 * notices would attribute a whole range one commit at a time
 * (mantahostels#1825), the release would drop a live claim over somebody
 * else's paths (mantahostels#2336), and the record would take a replayed
 * commit, which may be a neighbour's, as this session's own (#766). A route
 * that will not read stands them down too. The clean single cherry-pick costs
 * one missed notice, accepted because a multi-commit pick reads the same way
 * between its commits, which is the case worth suppressing.
 */

const steps = require("./post-commit-steps.js");

/**
 * @typedef {import("./precommit-dispatch.js").RowResult} RowResult
 * @typedef {import("./precommit-dispatch.js").Row & {
 *   run: (
 *     io: { cwd: string, env: NodeJS.ProcessEnv },
 *     programs?: import("./post-commit-steps.js").Programs,
 *   ) => RowResult | Promise<RowResult>,
 * }} PostCommitRow
 */

/** @type {import("./precommit-dispatch.js").When} */
const GATED = { unlessRoutes: ["post-commit-stand-down"] };

/**
 * @param {string} id
 * @param {PostCommitRow["run"]} run
 * @param {boolean} gated
 * @returns {PostCommitRow}
 */
const row = (id, run, gated) => ({
	id,
	arm: { always: true },
	...(gated && { when: GATED }),
	policy: "warn",
	run,
});

/* Since mantahostels#316 a session pushes once, when its work is done, so a
 * non-zero unpushed count mid-session is a reminder that commits are still
 * local, never a prompt to push now. */
/** @type {PostCommitRow[]} */
const ROWS = [
	row("unpushed-report", steps.unpushedReport, false),
	row("new-shared-faults", steps.newSharedFaultsRow, true),
	row(
		"instruction-surface",
		steps.touchedByRow("check-instruction-surface.js"),
		true,
	),
	row("guard-registry", steps.touchedByRow("check-guard-registry.js"), true),
	row("claim-release", steps.releaseClaimsRow, true),
	row("commit-record", steps.recordCommitRow, true),
	row("hook-shims", steps.keepShimsRow, false),
	row("dropped-review-tier", steps.droppedReviewTier, false),
];

module.exports = { ROWS };
