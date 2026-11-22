const { commitRoute } = require("./commit-route.js");
const { readHookGitDir } = require("./hook-entry.js");
const { dispatch } = require("./precommit-dispatch.js");
const steps = require("./post-commit-steps.js");

/**
 * @typedef {import("./precommit-dispatch.js").RowResult} RowResult
 * @typedef {import("./precommit-dispatch.js").Row & {
 *   script: string,
 *   run: (
 *     io: import("./post-commit-steps.js").RunIo,
 *     programs?: import("./post-commit-steps.js").Programs,
 *   ) => RowResult | Promise<RowResult>,
 * }} PostCommitRow
 */

/** @type {import("./precommit-dispatch.js").When} */
const GATED = { unlessRoutes: ["post-commit-stand-down"] };

/**
 * @param {string} id
 * @param {string} script
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
 * @param {import("./post-commit-steps.js").HookIo} io
 * @param {{
 *   write: (fd: number, text: string) => void,
 *   interrupted?: () => Promise<number | null>,
 *   rows?: PostCommitRow[],
 *   programs?: import("./post-commit-steps.js").Programs,
 * }} opts
 * @returns {Promise<number>}
 */
function runPostCommit(
	io,
	{ write, interrupted = async () => null, rows, programs },
) {
	const run = steps.buildRunIo(io);
	return dispatch({
		rows: rows ?? ROWS,
		gates: "all",
		voice: { hook: "post-commit", noun: "step" },
		ports: {
			load: (step) => () => step.run(run, programs),
			write,
			interrupted,
			route: () => commitRoute("post-commit", readHookGitDir(io.cwd, io.env)),
		},
	});
}

module.exports = { ROWS, runPostCommit };
