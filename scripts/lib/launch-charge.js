/*
 * launch-charge.js — what one launch is charged against a memory rung, by its
 * run kind (#4911): every measured peak, its measurement and its residuals.
 * Pure: it reads no `ps`, no marker and no file. Each caller works out the
 * kind of its launch, from a marker or a command line, and asks here.
 */

/*
 * A whole suite's is the highest of six `npm run test -- --full=<cause>
 * --shared --shard=k/2` runs, three of each shard, 9 Nov 2026 on a loaded
 * machine, each run's process tree PSS sampled each second from its spawn:
 * 1,208-1,929 MB (#4592), the highest from a run the 840 s suite ceiling
 * killed, 921 s after its `npm` spawned and 422 s after its peak. Shards,
 * since an unsharded run meets the ceiling about halfway. The lander record's
 * whole runs, 28 Oct - 5 Nov, peaked at most 1,820 MB on any day but 4 Nov;
 * that day's 2,087-2,627 MB was its tree, which reproduced at 2,632-2,743 MB,
 * the file that drove it unnamed. No margin, the rung holding DRAW_MARGIN_MB.
 * MOVE IT ONLY WITH A RE-MEASUREMENT. Residual: an unsharded run, charged
 * this, is unmeasured; a tree regressing as 4 Nov's did is charged ~800 MB
 * short; a spike between samples, short.
 */
const SUITE_PEAK_MB = 1929;

/*
 * A part-suite's peak (#3806): the line over the highest process tree PSS of 33
 * recorded part-suites, sampled each second, 2 Nov 2026, the five largest test
 * files by bytes among them. By workers at 1-5: 543, 547, 738, 939, 1,204 MB up
 * to 36 files; 96 and 120 files at 5 workers reached 1,539 and 1,482 MB. Never
 * above the whole suite's, and with no margin, the rung holding DRAW_MARGIN_MB.
 * Residual: a part-suite peaking above this line is charged short by the
 * difference.
 */
const PART_BASE_MB = 380;
const PART_WORKER_MB = 175;
const PART_FILE_MB = 3;

/*
 * The peaks of the runners on no ladder or slot of the queues' own, each
 * measured as #3806 measured a part-suite (#4112): the process tree's PSS
 * sampled each second, 8 Nov 2026, on a loaded machine.
 *
 * pytest by xdist workers, 15 runs of two repos' suites: at 0 (`-n 0`), 1, 2,
 * 4 and 8 (`-n auto`) the highest read 144, 169, 256, 424 and 724 MB. The line
 * over them, no margin, as a part-suite's.
 *
 * `node --test`, one repo's 35-file suite: 363 and 381 MB at its default
 * concurrency, 323 MB at 1.
 *
 * `next build`, one site's: 972 and 979 MB cold, 624 MB warm.
 *
 * MOVE ONE ONLY WITH A RE-MEASUREMENT. Residual: a suite or site heavier than
 * the one measured is charged short by the difference; pytest's workers set in
 * its config's `addopts` are read as none; a `python3 -m unittest` or bare
 * Python test file, unmeasured, is charged pytest's line at no workers; an
 * `auto` run is charged a worker a CPU, never capped by `--maxprocesses`,
 * `PYTEST_XDIST_AUTO_NUM_WORKERS` or physical cores, so it errs high.
 */
const PYTEST_BASE_MB = 150;
const PYTEST_WORKER_MB = 75;
const NODE_TEST_PEAK_MB = 381;
const NEXT_BUILD_PEAK_MB = 979;

/* The cold peak of `npm run typecheck`, by the TypeScript major version it
 * runs: the higher of two runs' cgroup `memory.peak` with no build info, 5's
 * (#4849) and 7's at `--checkers 2` (#4892). A compiler unread, or a major
 * not here, is charged the highest. MOVE ONE ONLY WITH A RE-MEASUREMENT.
 * Residual: a bare `tsc`, a `queue-run.js --tsc -- tsc` typed outside npm and
 * `typecheck-mods.js` run outside npm run 7 at its default checker count,
 * unmeasured, and are charged the `--checkers 2` figure, short by what the
 * extra checkers draw (#4887 read 4 at ~130 MB over 2). */
const TSC_PEAKS_MB = new Map([
	[5, 2045],
	[7, 1497],
]);
const TSC_PEAK_MB = Math.max(...TSC_PEAKS_MB.values());

/* What admission holds back for a lander, by the kind of run it holds
 * (#3323), and what the queues' climb charges its marker (#3973): a tree
 * peak, never a machine-wide MemAvailable dip (#2508), with no margin, the
 * rung holding DRAW_MARGIN_MB. Whole: a shard's, SUITE_PEAK_MB, as each shard
 * takes a slot of its own and runs the measured command; the Python suite the
 * last shard runs after it, at 2 workers, peaks far under (#4112's 256 MB)
 * (#4771). Named: the highest of 341 runs of 1-6 files off the lander run
 * record, each run's tree PSS sampled every 2 s from its spawn, 28 Oct - 5 Nov
 * 2026, 937 MB. A named run past those 6 files, one unsharded group, is
 * unmeasured and charged a shard's. Residual: the lander packs its shards by
 * timings, the measured runs by file count, so a shard holding heavier files
 * together is charged short; a repo declaring no `fullTestShards` runs its
 * whole suite in one slot, unmeasured; the `npm ci` a slot opens with is
 * unsampled; a spike between two samples is charged short. */
const LANDER_CHARGE_MB = { whole: SUITE_PEAK_MB, named: 940 };
const NAMED_MEASURED_FILES = 6;

/**
 * A launch by its run kind, with what that kind is sized by. A lander's
 * `files` are the test files its run names; none names a whole run, as does a
 * lander marker whose charge is not a number.
 * @typedef {{ kind: "suite" }
 *   | { kind: "part", files: number, workers: number }
 *   | { kind: "pytest", workers: number }
 *   | { kind: "node-test" }
 *   | { kind: "next-build" }
 *   | { kind: "tsc", major?: number | null }
 *   | { kind: "lander", files: readonly string[] }} Launch
 */

/**
 * The peak MB `launch` is charged.
 * @param {Launch} launch
 * @returns {number}
 */
function chargeMb(launch) {
	switch (launch.kind) {
		case "suite":
			return SUITE_PEAK_MB;
		case "part":
			return Math.min(
				SUITE_PEAK_MB,
				PART_BASE_MB +
					PART_WORKER_MB * launch.workers +
					PART_FILE_MB * launch.files,
			);
		case "pytest":
			return PYTEST_BASE_MB + PYTEST_WORKER_MB * launch.workers;
		case "node-test":
			return NODE_TEST_PEAK_MB;
		case "next-build":
			return NEXT_BUILD_PEAK_MB;
		case "tsc":
			return (
				(launch.major == null ? undefined : TSC_PEAKS_MB.get(launch.major)) ??
				TSC_PEAK_MB
			);
		case "lander":
			return launch.files.length === 0 ||
				launch.files.length > NAMED_MEASURED_FILES
				? LANDER_CHARGE_MB.whole
				: LANDER_CHARGE_MB.named;
	}
}

module.exports = { chargeMb };
