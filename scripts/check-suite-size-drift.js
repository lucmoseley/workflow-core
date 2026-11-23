#!/usr/bin/env node

const { runCheck, errMessage } = require("./lib/check.js");
const { scriptPath } = require("./lib/script-path.js");
const { SUITE_LADDER_MEASURED_AT } = require("./lib/admission.js");
const { execFileSync } = require("node:child_process");
const { readVitestCollected } = require("./lib/vitest-collected.js");
const { execGit } = require("./lib/git.js");

// lucmoseley/mantahostels#954 guess
const DEFAULT_THRESHOLD_PCT = 25;

// guess: ~160x the 25 KB tracked-path list, lucmoseley/mantahostels#954
const LS_FILES_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * @param {any} ctx
 * @returns {string[]}
 */
function readSuiteFiles(ctx) {
	const git = (/** @type {string[]} */ args, /** @type {string} */ what) => {
		try {
			return execGit(args, {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				maxBuffer: LS_FILES_MAX_BUFFER,
			});
		} catch (e) {
			return ctx.broken(
				`git ${args[0]} failed while ${what}: ${errMessage(e)}. No suite counted.`,
			);
		}
	};
	const root = git(
		["rev-parse", "--show-toplevel"],
		"locating the repo root",
	).trim();
	const tracked = git(["-C", root, "ls-files", "-z"], "listing tracked files")
		.split("\0")
		.filter(Boolean);
	try {
		return readVitestCollected(root, tracked, execFileSync);
	} catch (e) {
		return ctx.broken(
			`vitest list failed while listing the suite: ${errMessage(e)}. No suite counted.`,
		);
	}
}

runCheck({
	name: "suite-size-drift",
	usage:
		"node check-suite-size-drift.js [--threshold <pct>] [--baseline <files>] [--notify] [--json] [--warn]",
	valueFlags: ["--threshold", "--baseline"],
	run(/** @type {any} */ ctx) {
		const baselineArg = ctx.value("--baseline", null);
		const baseline = Number(baselineArg ?? SUITE_LADDER_MEASURED_AT.files);
		if (!Number.isFinite(baseline) || baseline <= 0)
			ctx.usageError(`--baseline must be a positive number, got ${baseline}`);

		const threshold = Number(
			ctx.value("--threshold", String(DEFAULT_THRESHOLD_PCT)),
		);
		if (!Number.isFinite(threshold) || threshold <= 0)
			ctx.usageError(`--threshold must be a positive number, got ${threshold}`);

		const files = readSuiteFiles(ctx).length;
		const drift = ((files - baseline) / baseline) * 100;
		const driftPct = Math.round(drift);
		const data = {
			files,
			baseline,
			driftPct,
			threshold,
			measuredAt: SUITE_LADDER_MEASURED_AT,
		};

		const signed = `${driftPct >= 0 ? "+" : ""}${driftPct}%`;
		const stamp = `${SUITE_LADDER_MEASURED_AT.issue}, ${SUITE_LADDER_MEASURED_AT.date}`;
		const { lowerBound } = SUITE_LADDER_MEASURED_AT;
		if (lowerBound && baselineArg === null)
			return {
				okLine: `the concurrent-suite memory ladder is a lower bound (${stamp}): the ${lowerBound.ceilingS} s ceiling cut each bench suite after ${lowerBound.reachedMin}–${lowerBound.reachedMax} of its ${baseline} files, so its rungs are floors and the suite's ${files} test files, ${signed}, ask no re-measure.`,
				data,
			};
		if (Math.abs(drift) < threshold)
			return {
				okLine: `suite is ${files} test files, ${signed} against the ${baseline} the memory ladder was measured on.`,
				data,
			};

		ctx.warn(
			"SUITE-SIZE-DRIFT",
			`suite is ${files} test files, ${signed} against the ${baseline} the concurrent-suite memory ladder was measured on (${stamp}).`,
			data,
			// #1591
			`SUITE-SIZE-DRIFT\t${baseline}`,
		);
		ctx.say(
			`The concurrent-test-suite memory ladder was measured on a suite of ${baseline} test files (${stamp}). It is now ${files} — ${signed}.`,
		);
		ctx.say(
			"Every figure in that ladder is earlyoom's line plus one suite's memory dip, and the dip scales with what the suite runs. Treat the ladder as unverified until it is re-measured.",
		);
		ctx.say(
			`  Re-measure:  OUTDIR=<dir> python3 ${scriptPath("bench_suite_concurrency.py")} 1 2 3 1 2 3 --require-quiet=3`,
		);
		ctx.say(
			"  Two rows per count, and --require-quiet is what makes a row trustworthy: mantahostels#954's ladder was set from rows a neighbouring session moved memory under (mantahostels#1841).",
		);
		ctx.say(
			"  Then restate, all five: docs/environment.md (owner), docs/agents/guard-registry.md §Machine limits, .claude/skills/pick-next/SKILL.md §5, SUITE_DIP_MB, SUITE_MAX and SUITE_LADDER_MEASURED_AT in scripts/lib/suite-ladder.js, and suite-concurrency-ladder in docs/machinery-superseded.json.",
		);
		return { noun: "drifted ladder", count: 1, data };
	},
});
