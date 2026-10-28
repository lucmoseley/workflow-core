#!/usr/bin/env node
/*
 * check-suite-size-drift.js — has the test suite outgrown the memory ladder
 * measured on it?
 *
 * Usage:
 *   node check-suite-size-drift.js [--threshold <pct>] [--baseline <files>]
 *                                  [--notify] [--json] [--warn]
 *
 * `docs/environment.md` §Concurrent test suites gates 1/2/3 concurrent `npm run
 * test` runs on resting `MemAvailable`, and every figure in that ladder is
 * `earlyoom`'s line plus THE DIP ONE SUITE COSTS plus a fitted margin. The dip
 * is a measurement, and what it measures is how much work the suite does.
 *
 * Suite size joined that ladder's invalidation list at mantahostels#954, which is why this
 * exists. It counts the tracked files vitest would collect and compares them
 * against the count recorded beside the ladder's own constants
 * (`SUITE_LADDER_MEASURED_AT` in `scripts/lib/suite-ladder.js`), so the baseline
 * moves when and only when someone re-measures.
 *
 * FILE COUNT, NOT TEST COUNT, deliberately: a test count needs a collection
 * run. The files are the tracked ones vitest's own `vitest list --filesOnly`
 * keeps, so a repo with a vitest config needs its vitest installed. A file that
 * grows its own assertion count without being added is the residual, and
 * nothing here sees it.
 *
 * WARN-ONLY, ALWAYS. The finding is "go and measure", which no commit can
 * discharge and no session should be blocked on.
 *
 * IMPLICIT:  on `npm run status` (scripts/status-report.js), and in the daily repo-checks run, says when the test suite has drifted past 25% of the size the concurrent-suite memory ladder was measured on. It refuses nothing.
 * JUSTIFIED: fail-safe — the ladder going stale is silent and the cost of missing it is a frozen machine, while the cost of a spurious warning is one line in a status report; a run that cannot enumerate the suite is BROKEN rather than all-clear.
 * DEFEAT:    convenience — --baseline and --threshold move the comparison on a hand run, and editing SUITE_LADDER_MEASURED_AT in scripts/lib/suite-ladder.js silences it outright. That constant's own comment forbids moving it without a re-measurement; nothing enforces that.
 */

const { runCheck, errMessage } = require("./lib/check.js");
const { SUITE_LADDER_MEASURED_AT } = require("./lib/admission.js");
const { execFileSync } = require("node:child_process");
const { readVitestCollected } = require("./lib/vitest-collected.js");
const { execGit } = require("./lib/git.js");

/*
 * The drift at which the ladder is worth re-measuring, in percent of the
 * measured file count, either direction. A judgement, not a measurement,
 * derived at mantahostels#954 and deliberately set low.
 *
 * SHRINKAGE WARNS TOO: a ladder measured on a suite that has since shrunk
 * refuses concurrency the machine could afford.
 */
const DEFAULT_THRESHOLD_PCT = 25;

/* ~160x the 25 KB this repo's tracked-path list runs to, so it bounds a runaway
 * without ever truncating a real read. */
const LS_FILES_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * The tracked test files vitest collects, or BROKEN.
 *
 * READ FROM THE REPO ROOT, NOT THE CWD. `git ls-files` answers about the
 * subtree it is run in, so a caller sitting in `docs/` would otherwise be told
 * the suite is empty and shown a confident -100% drift.
 *
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
		const baseline = Number(
			ctx.value("--baseline", String(SUITE_LADDER_MEASURED_AT.files)),
		);
		if (!Number.isFinite(baseline) || baseline <= 0)
			ctx.usageError(`--baseline must be a positive number, got ${baseline}`);

		const threshold = Number(
			ctx.value("--threshold", String(DEFAULT_THRESHOLD_PCT)),
		);
		if (!Number.isFinite(threshold) || threshold <= 0)
			ctx.usageError(`--threshold must be a positive number, got ${threshold}`);

		const files = readSuiteFiles(ctx).length;
		/* Compared unrounded so `--threshold 25` means 25%, not 24.5%. */
		const drift = ((files - baseline) / baseline) * 100;
		const driftPct = Math.round(drift);
		const data = {
			files,
			baseline,
			driftPct,
			threshold,
			measuredAt: SUITE_LADDER_MEASURED_AT,
		};

		if (Math.abs(drift) < threshold)
			return {
				okLine: `suite is ${files} test files, ${driftPct >= 0 ? "+" : ""}${driftPct}% against the ${baseline} the memory ladder was measured on.`,
				data,
			};

		const signed = `${driftPct >= 0 ? "+" : ""}${driftPct}%`;
		ctx.warn(
			"SUITE-SIZE-DRIFT",
			`suite is ${files} test files, ${signed} against the ${baseline} the concurrent-suite memory ladder was measured on (${SUITE_LADDER_MEASURED_AT.issue}, ${SUITE_LADDER_MEASURED_AT.date}).`,
			data,
			/* The live count is out of the key: it moves with every test file
			 * added, and the finding stands until the ladder is re-measured (#1591). */
			`SUITE-SIZE-DRIFT\t${baseline}`,
		);
		ctx.say(
			`The concurrent-test-suite memory ladder was measured on a suite of ${baseline} test files (${SUITE_LADDER_MEASURED_AT.issue}, ${SUITE_LADDER_MEASURED_AT.date}). It is now ${files} — ${signed}.`,
		);
		ctx.say(
			"Every figure in that ladder is earlyoom's line plus one suite's memory dip, and the dip scales with what the suite runs. Treat the ladder as unverified until it is re-measured.",
		);
		ctx.say(
			"  Re-measure:  OUTDIR=<dir> python3 scripts/bench_suite_concurrency.py 1 2 3 1 2 3 --require-quiet=3",
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
