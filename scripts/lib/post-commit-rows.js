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
 * that will not read stands them down too. The clean single cherry-pick
 * costs that commit's stand-down rows: new-shared-faults, instruction-surface,
 * guard-registry, claim-release and commit-record.
 */

const { commitRoute } = require("./commit-route.js");
const { readHookGitDir } = require("./hook-entry.js");
const { dispatch } = require("./precommit-dispatch.js");
const steps = require("./post-commit-steps.js");

/**
 * @typedef {import("./precommit-dispatch.js").RowResult} RowResult
 * @typedef {import("./precommit-dispatch.js").Row & {
 *   script: string,
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
 * @param {string} script the file the row runs, for check-guard-registry.js
 * @param {PostCommitRow["run"]} run
 * @param {boolean} gated
 * @returns {PostCommitRow}
 */
const row = (id, script, run, gated) => ({
	id,
	script,
	arm: { always: true },
	...(gated && { when: GATED }),
	policy: "warn",
	run,
});

/** @type {PostCommitRow[]} */
const ROWS = [
	row(
		"unpushed-report",
		"scripts/lib/landing-refs.js",
		steps.unpushedReport,
		false,
	),
	row(
		"new-shared-faults",
		`scripts/${steps.PROGRAM_FILES.newSharedFaults}`,
		steps.newSharedFaultsRow,
		true,
	),
	row(
		"instruction-surface",
		`scripts/${steps.PROGRAM_FILES.instructionSurface}`,
		steps.touchedByRow(steps.PROGRAM_FILES.instructionSurface),
		true,
	),
	row(
		"guard-registry",
		`scripts/${steps.PROGRAM_FILES.guardRegistry}`,
		steps.touchedByRow(steps.PROGRAM_FILES.guardRegistry),
		true,
	),
	row(
		"claim-release",
		`scripts/${steps.PROGRAM_FILES.arbiter}`,
		steps.releaseClaimsRow,
		true,
	),
	row(
		"commit-record",
		`scripts/${steps.PROGRAM_FILES.arbiter}`,
		steps.recordCommitRow,
		true,
	),
	row(
		"hook-shims",
		`scripts/${steps.PROGRAM_FILES.keepShims}`,
		steps.keepShimsRow,
		false,
	),
	row(
		"dropped-review-tier",
		"scripts/lib/post-commit-steps.js",
		steps.droppedReviewTier,
		false,
	),
];

/**
 * The registry's run under `io`, each row's output through `write`: the
 * wiring scripts/post-commit-dispatch.js and the tests share.
 * @param {import("./post-commit-steps.js").HookIo} io
 * @param {{
 *   write: (fd: number, text: string) => void,
 *   interrupted?: () => Promise<number | null>,
 *   rows?: PostCommitRow[],
 *   programs?: import("./post-commit-steps.js").Programs,
 * }} opts `programs` absent, each row runs the real programs
 * @returns {Promise<number>}
 */
function runPostCommit(
	io,
	{ write, interrupted = async () => null, rows, programs },
) {
	return dispatch({
		rows: rows ?? ROWS,
		gates: "all",
		voice: { hook: "post-commit", noun: "step" },
		ports: {
			load: (step) => () => step.run(io, programs),
			write,
			interrupted,
			route: () => commitRoute("post-commit", readHookGitDir(io.cwd, io.env)),
		},
	});
}

module.exports = { ROWS, runPostCommit };
