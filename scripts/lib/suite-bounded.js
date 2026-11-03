/*
 * suite-bounded.js — what a vitest run weighs at admission (workflow-core#1186, workflow-core#2558,
 * workflow-core#2931): the test files a `run-vitest.js` launch or a running runner line is
 * bounded to, read off its argv, and the workers and whole-suite slot that
 * count is charged.
 */

const { JS_TEST_FILE } = require("./test-kind.js");

/*
 * W, the vitest workers a whole suite runs and is charged at: vitest.config.ts's
 * `maxWorkers`. WHOLE_SLOT_FILES is the whole-slot bound (workflow-core#2931): a run
 * resolving to fewer test files than it, in its own repo, is a part-suite,
 * charged at its file count up to W, taking no whole-suite slot and
 * backfilling beside one (workflow-core#2578). A touched run is a part-suite at any count
 * (workflow-core#2935, launch-route.js's `isTouchedRun`).
 *
 * WHOLE_SLOT_FILES is a quarter of the suite the memory ladder was measured
 * on, SUITE_LADDER_MEASURED_AT in lib/suite-ladder.js: UNTRACED (workflow-core#2868
 * §Values). The tests spell it in whole-slot-bound.ts, which
 * suite-bounded.test.ts holds to this one through `weighFiles` and
 * suite-ladder.test.ts to the ladder's suite.
 */
const WHOLE_SUITE_WORKERS = 5;
const WHOLE_SLOT_FILES = 121;
const WHOLE_RUN = { workers: WHOLE_SUITE_WORKERS, part: false };

/**
 * @param {number | null} files
 * @returns {{ workers: number, part: boolean }}
 */
const weighFiles = (files) =>
	files !== null && files < WHOLE_SLOT_FILES ? buildPartRun(files) : WHOLE_RUN;

/** @param {number} files */
const buildPartRun = (files) => ({
	workers: Math.min(files, WHOLE_SUITE_WORKERS),
	part: true,
});

/**
 * A run that took no whole slot is a part-suite whatever its count, a touched
 * run of WHOLE_SLOT_FILES or more among them (workflow-core#2935).
 * @param {import("./suite-handoff.js").CarriedWeight} carried
 */
const weighCarried = (carried) =>
	carried.wholeSlot
		? WHOLE_RUN
		: buildPartRun(carried.resolvedFiles ?? WHOLE_SUITE_WORKERS);

/*
 * The flags whose next word, where it opens with no `-`, is their value rather
 * than a path or filter: vitest's own valued flags, and `--changed`, whose next
 * word run-vitest.js takes as its ref (workflow-core#2454). Residual: a valued flag off this
 * list leaves its value read as a filter, so the run reads unbounded — the
 * over-charging direction.
 */
const SUITE_VALUED_FLAGS = new Set([
	"--changed",
	"-t",
	"--testNamePattern",
	"--project",
	"--reporter",
	"-c",
	"--config",
	"-r",
	"--root",
	"--dir",
	"--shard",
	"--pool",
	"--environment",
	"--outputFile",
	"--maxWorkers",
	"--minWorkers",
	"--retry",
	"--bail",
	"--testTimeout",
]);

/**
 * How many test-file-shaped words run-vitest.js's argv names, where the run is
 * bounded to them; null where it is not.
 *
 * Not bounded: an `--adopt` run, which selects every reader of the paths it
 * names, test files among them (workflow-core#1213); a run naming no test file (workflow-core#1196); and
 * one carrying any other bare word that is no flag's value, which vitest reads
 * as a substring filter over paths (workflow-core#2559). Residual: a directory filter
 * (`-- scripts/lib/`) therefore reads as unbounded.
 * @param {string[]} argv the words after the runner
 * @param {(word: string) => string} [read] a word's text, where a quoted span
 *   was blanked in it
 * @returns {number | null}
 */
function runnerTestFileCount(argv, read = (w) => w) {
	if (argv.includes("--adopt")) return null;
	return namedFiles(bareWords(argv), read);
}

/**
 * How many `words` there are where every one is a test file; null where any
 * is not, or there are none.
 * @param {string[]} words the words `bareWords` returns
 * @param {(word: string) => string} [read] runnerTestFileCount's
 * @returns {number | null}
 */
const namedFiles = (words, read = (w) => w) =>
	words.length > 0 && words.every((w) => JS_TEST_FILE.test(read(w)))
		? words.length
		: null;

/**
 * `argv`'s words that are neither a flag nor a valued flag's value: the paths
 * and filters vitest selects on.
 * @param {string[]} argv
 * @returns {string[]}
 */
function bareWords(argv) {
	/** @type {string[]} */
	const words = [];
	let prev = "";
	for (const word of argv) {
		if (!word.startsWith("-") && !SUITE_VALUED_FLAGS.has(prev))
			words.push(word);
		prev = word;
	}
	return words;
}

/**
 * How many of its repo's test files run-vitest.js `argv`, its wrapper flags
 * stripped and no selection left to expand, runs (workflow-core#2931): the files it names
 * where it is bounded to them; else those its bare words match, vitest
 * reading each as a path filter (workflow-core#2559); else the whole suite. Null where
 * the suite went unread, or a `--changed` or `--adopt` selection was never
 * expanded, which no count of the words can stand in for.
 * @param {string[]} argv
 * @param {() => string[] | null} readSuite the test files vitest collects in
 *   the run's repo, read only where `argv` names none
 * @returns {number | null}
 */
function resolvedFileCount(argv, readSuite) {
	if (argv.some((w) => w === "--adopt" || /^--changed(=|$)/.test(w)))
		return null;
	const filters = bareWords(argv);
	const named = namedFiles(filters);
	if (named !== null) return named;
	const suite = readSuite();
	if (suite === null) return null;
	return filters.length === 0
		? suite.length
		: suite.filter((p) => filters.some((f) => p.includes(f))).length;
}

/**
 * runnerTestFileCount over a wrapper or npm vitest launch's own argv; null for
 * any other launch. The words after the script name are run-vitest.js's argv,
 * `test:changed`'s behind the `--changed` its script bakes in, npm taking the
 * first `--` (workflow-core#2454).
 * @param {import("./suite-launch.js").Launch} launch
 * @param {string[]} words the launch's words
 * @param {(word: string) => string} [read] runnerTestFileCount's
 * @returns {number | null}
 */
function launchTestFileCount(launch, words, read) {
	const argv = launchArgv(launch, words);
	if (argv === null) return null;
	return runnerTestFileCount(
		launch.script === "test:changed" ? ["--changed", ...argv] : argv,
		read,
	);
}

/**
 * run-vitest.js's argv off a wrapper or npm vitest launch's words, npm taking
 * the first `--` (workflow-core#2454); null for any other launch.
 * @param {import("./suite-launch.js").Launch} launch
 * @param {string[]} words the launch's words
 * @returns {string[] | null}
 */
function launchArgv(launch, words) {
	if (launch.kind !== "wrapper" && launch.kind !== "npm-vitest") return null;
	const argv = words.slice(launch.taken);
	if (launch.kind === "npm-vitest" && argv[0] === "--") argv.shift();
	return argv;
}

const VITEST_ONESHOT = /[.]bin\/vitest( .*)? (run|--run)( |$)/;
const VITEST_WATCH = / (--watch|watch)( |=|$)/;

/** @param {string} line */
const isVitestWatchLine = (line) =>
	!VITEST_ONESHOT.test(line) || VITEST_WATCH.test(line);

/**
 * The vitest workers a running run can occupy (workflow-core#2560), and whether it is a
 * part-suite. A run carrying its launch record is weighed by the resolved
 * count and slot it carries (workflow-core#2931); a watcher is whole; any other run, a
 * hand-typed `vitest run` among them, is `weighFiles` over the files its
 * words after the binary and its `run` name, whole where it names none or
 * carries a bare word that is no flag's value.
 * @param {string} line
 * @param {import("./suite-handoff.js").CarriedWeight | null} [carried]
 * @returns {{ workers: number, part: boolean }}
 */
function vitestLineWeigh(line, carried = null) {
	if (isVitestWatchLine(line)) return WHOLE_RUN;
	if (carried) return weighCarried(carried);
	const words = line.trim().split(/\s+/);
	let rest = words.slice(words.findIndex((w) => /[.]bin\/vitest$/.test(w)) + 1);
	if (rest[0] === "run") rest = rest.slice(1);
	return weighFiles(runnerTestFileCount(rest));
}

module.exports = {
	WHOLE_SLOT_FILES,
	WHOLE_SUITE_WORKERS,
	SUITE_VALUED_FLAGS,
	resolvedFileCount,
	weighFiles,
	weighCarried,
	runnerTestFileCount,
	launchArgv,
	launchTestFileCount,
	isVitestWatchLine,
	vitestLineWeigh,
};
