// measured 1,929 MB, the highest of six shard runs, #4592
const SUITE_PEAK_MB = 1929;

// measured 543-1,539 MB over 33 part-suites at 1-5 workers, #3806
const PART_BASE_MB = 380;
// measured 543-1,539 MB over 33 part-suites at 1-5 workers, #3806
const PART_WORKER_MB = 175;
// measured 543-1,539 MB over 33 part-suites at 1-5 workers, #3806
const PART_FILE_MB = 3;

// measured 144-724 MB at 0-8 xdist workers, #4112
const PYTEST_BASE_MB = 150;
// measured 144-724 MB at 0-8 xdist workers, #4112
const PYTEST_WORKER_MB = 75;
// measured 381 MB, #4112
const NODE_TEST_PEAK_MB = 381;
// measured 979 MB cold, #4112
const NEXT_BUILD_PEAK_MB = 979;

// measured 2,045 MB (TypeScript 5) and 1,497 MB (7) cgroup memory.peak, #4849 #4892
const TSC_PEAKS_MB = new Map([
	[5, 2045],
	[7, 1497],
]);
const TSC_PEAK_MB = Math.max(...TSC_PEAKS_MB.values());

// measured 937 MB, the highest of 341 named runs, #3973
const LANDER_CHARGE_MB = { whole: SUITE_PEAK_MB, named: 940 };
// measured named runs of 1-6 files, #3973
const NAMED_MEASURED_FILES = 6;

/**
 * @typedef {{ kind: "suite" }
 *   | { kind: "part", files: number, workers: number }
 *   | { kind: "pytest", workers: number }
 *   | { kind: "node-test" }
 *   | { kind: "next-build" }
 *   | { kind: "tsc", major?: number | null }
 *   | { kind: "lander", files: readonly string[] }} Launch
 */

/**
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
