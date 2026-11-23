const { JS_TEST_FILE } = require("./test-kind.js");

// measured 230 s median suite at W=5, #2772
const WHOLE_SUITE_WORKERS = 5;
// guess: a quarter of the 485-file suite the ladder was measured on, #2931
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

/** @param {import("./suite-handoff.js").CarriedWeight} carried */
const weighCarried = (carried) =>
	carried.wholeSlot
		? WHOLE_RUN
		: buildPartRun(carried.resolvedFiles ?? WHOLE_SUITE_WORKERS);

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
 * @param {string[]} argv
 * @param {(word: string) => string} [read]
 * @returns {number | null}
 */
function runnerTestFileCount(argv, read = (w) => w) {
	if (argv.includes("--adopt")) return null;
	return namedFiles(bareWords(argv), read);
}

/**
 * @param {string[]} words
 * @param {(word: string) => string} [read]
 * @returns {number | null}
 */
const namedFiles = (words, read = (w) => w) =>
	words.length > 0 && words.every((w) => JS_TEST_FILE.test(read(w)))
		? words.length
		: null;

/** @param {string[]} argv @returns {string[]} */
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
 * @param {string[]} argv
 * @param {() => string[] | null} readSuite
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
 * @param {import("./suite-launch.js").Launch} launch
 * @param {string[]} words
 * @param {(word: string) => string} [read]
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
 * @param {import("./suite-launch.js").Launch} launch
 * @param {string[]} words
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
 * @param {string} line
 * @param {import("./suite-handoff.js").CarriedWeight | null} [carried]
 * @returns {{ workers: number, part: boolean }}
 */
function vitestLineWeigh(line, carried = null) {
	if (isVitestWatchLine(line)) return WHOLE_RUN;
	if (carried) return weighCarried(carried);
	return weighFiles(lineTestFileCount(line));
}

/** @param {string} line */
function lineTestFileCount(line) {
	const words = line.trim().split(/\s+/);
	let rest = words.slice(words.findIndex((w) => /[.]bin\/vitest$/.test(w)) + 1);
	if (rest[0] === "run") rest = rest.slice(1);
	return runnerTestFileCount(rest);
}

/**
 * @param {string} line
 * @param {import("./suite-handoff.js").CarriedWeight | null} [carried]
 * @returns {{ part: boolean, files?: number }}
 */
function vitestLineSize(line, carried = null) {
	const { part } = vitestLineWeigh(line, carried);
	const files = carried ? carried.resolvedFiles : lineTestFileCount(line);
	return part && files !== null ? { part, files } : { part };
}

module.exports = {
	bareWords,
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
	vitestLineSize,
};
