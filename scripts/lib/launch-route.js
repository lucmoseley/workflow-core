/*
 * launch-route.js — the wrapper flags `scripts/run-vitest.js` consumes, the
 * one place a launch's route is decided from them (workflow-core#1498), and the refusal of
 * a launch whose runner flags npm swallowed (workflow-core#2284). A module of
 * its own so the route table is tested through its export rather than one
 * exported for the test (workflow-core#1633).
 */

const { shellWord } = require("./dirty-tree.js");
const { RETEST_FLAG } = require("./test-pass-marker.js");
const { JS_TEST_FILE } = require("./test-kind.js");
const { runnerTestFileCount } = require("./suite-bounded.js");
const {
	ADOPT_FLAG,
	CHANGED_FLAG,
	adoptFlag,
	changedFlag,
	isChangedOnlyArgv,
	isRetestOnlyArgv,
	retestFlag,
} = require("./changed-selection.js");

const QUEUE_FLAG = "--queue";

/* `--isolated`: run the suite against a frozen worktree (mantahostels#2169);
 * why, above run-vitest.js's `openWorktree`. */
const ISOLATED_FLAG = "--isolated";

/*
 * `--shared`: THE ESCAPE FROM `--full`'S ISOLATION BELOW (mantahostels#2278), from an
 * escalated default's (mantahostels#3208), and from the narrowed default's overlay
 * worktree (workflow-core#812).
 */
const SHARED_FLAG = "--shared";

/*
 * `--full`: THE ESCAPE FROM mantahostels#3208'S DEFAULT NARROWING.
 *
 * A session that types `--full=<cause>` gets the isolated whole-suite path
 * unconditionally, a bare `--full` being refused (below); full-shaped argv
 * without it takes the narrowed path in run-vitest.js's `runDefault` instead.
 */
const FULL_FLAG = "--full";

/*
 * `--full=<cause>` (workflow-core#182): THE ONLY SPELLING THAT NAMES A REASON. A bare
 * `--full` REFUSES in run-vitest.js, naming the values in `FULL_CAUSES`.
 *
 * One word, so the cause cannot drift away from its flag (workflow-core#182). The stripper
 * that consumes the flag before vitest sees argv and the detector that decides
 * `fullFlag` both match this prefix, and the two must change together: a word
 * only the stripper matches silently narrows a full run, and one only the
 * detector matches hands vitest an argv it does not understand.
 */
const FULL_PREFIX = "--full=";

/**
 * The word in argv that spells `--full`, bare or with a cause — or null.
 * Matched before any flag is stripped: only the raw word can say whether a
 * cause was named.
 *
 * @param {string[]} argv
 * @returns {string|null}
 */
function fullFlagWord(argv) {
	return argv.find((w) => w === FULL_FLAG || w.startsWith(FULL_PREFIX)) ?? null;
}

/**
 * The four wrapper flags run-vitest.js consumes, none of which reaches vitest.
 * `--full=<cause>` is matched by prefix, the rest by the whole word.
 *
 * THE ONE LIST (workflow-core#188): guard-suite-concurrency.js's plain-`--full` limb
 * requires `stripWrapperFlags` rather than keeping a copy, so a fifth flag
 * added here reaches it unedited.
 */
const WRAPPER_FLAGS = new Set([
	QUEUE_FLAG,
	ISOLATED_FLAG,
	SHARED_FLAG,
	FULL_FLAG,
]);

/**
 * argv with the wrapper flags removed: what `isFullRunArgv` judges and what
 * vitest is handed.
 *
 * @param {string[]} argv
 * @returns {string[]}
 */
function stripWrapperFlags(argv) {
	return argv.filter(
		(word) => !WRAPPER_FLAGS.has(word) && !word.startsWith(FULL_PREFIX),
	);
}

/* Vitest's own name-filter flags: present, a run is narrowed to a subset of
 * a file's tests and is not full-shaped even where argv names no file.
 * `-t`/`--testNamePattern` only — `--changed` is checked separately via
 * `changedFlag`, which also accepts `--changed=<ref>`. */
const NAME_FILTER_FLAGS = new Set(["-t", "--testNamePattern"]);

/**
 * Whether `argv` (already stripped of `--queue`, `--isolated`, `--shared` and
 * `--full`, bare or with a cause) is FULL-SHAPED — no `--changed`, `--adopt`
 * or `--retest`, no name filter, no test file named.
 * Under `--full` this is the scope mantahostels#2278 isolates by default;
 * bare, it is what run-vitest.js's `runDefault` narrows to the diff instead,
 * escalating only where that narrowing would be worthless (mantahostels#3208).
 *
 * BEYOND THOSE FLAGS, ONLY A WORD SHAPED LIKE A TEST FILE DISQUALIFIES IT,
 * matched with the same `JS_TEST_FILE` regex vitest-collected.js's
 * `vitestList` filters vitest's own listing through.
 * A bare positional that is NOT test-file-shaped — a flag's own value, an
 * unrecognized flag — leaves the run full rather than narrowed: a wrong
 * "full" costs a needless worktree, a wrong "narrowed" costs exactly the
 * dirty-tree read mantahostels#2278 exists to stop.
 *
 * @param {string[]} argv
 * @returns {boolean}
 */
function isFullRunArgv(argv) {
	if (changedFlag(argv) || adoptFlag(argv) || retestFlag(argv)) return false;
	for (const word of argv) {
		if (NAME_FILTER_FLAGS.has(word)) return false;
		if (word.startsWith("--testNamePattern=")) return false;
		if (!word.startsWith("-") && JS_TEST_FILE.test(word)) return false;
	}
	return true;
}

/** @typedef {"overlay"|"worktree"|"shared"} Tree */

/**
 * @typedef {object} LaunchRoute
 * @property {string[]} rest argv stripped of the four wrapper flags
 * @property {"full"|"bare"|"touched"|"changed"|"named"} kind the launch's
 *   shape, which the run and the probe dispatch on and the queue-exit log
 *   names: `touched` is bare argv under the `landing` module (workflow-core#2930)
 * @property {Tree} tree the route intended
 * @property {Tree} fallback where the launch runs once its overlay will not
 *   build; `tree` itself on every other route
 * @property {Tree|null} escalation where a bare run's escalation to the whole
 *   suite runs; null on every other kind, `touched` included, which never
 *   escalates
 * @property {"full"|"diff"|"own"|"changed"|"adopt"|"retest"|"named"} source
 *   what the selection is taken from: the whole suite, the diff against the
 *   default's base, the session's own work, `--changed`'s diff, the adopted
 *   path list, the tests `--retest` names, or a named file or filter
 * @property {string|null} sessionId the id the route was decided with
 */

/**
 * Where a launch runs and what it selects from, decided once for the run, the
 * queue probe and its re-check (workflow-core#1498). Execution may still fall back: an
 * overlay that will not build runs on `fallback` instead, and the probe reads
 * the route intended.
 *
 * A session id overlays a bare run, `--isolated` or not, and a bare
 * `--changed` or a `--retest` unless `--isolated` was typed (workflow-core#812, workflow-core#1217,
 * workflow-core#1860), as it does a touched run. `--shared` beats every other flag.
 *
 * @param {string[]} argv the raw argv, `--full` already vetted
 * @param {string|null} sessionId
 * @param {{ landing?: boolean }} [modules] whether the `landing` module is on
 * @returns {LaunchRoute}
 */
function launchRoute(argv, sessionId, { landing = false } = {}) {
	const rest = stripWrapperFlags(argv);
	const shared = argv.includes(SHARED_FLAG);
	const isolated = !shared && argv.includes(ISOLATED_FLAG);
	const full = fullFlagWord(argv) !== null;
	const fullShaped = isFullRunArgv(rest);
	const changed = changedFlag(rest);
	const session = sessionId || null;
	const kind = routeKind(full, fullShaped, changed, landing);
	const overlaid =
		!shared &&
		session !== null &&
		(kind === "bare" ||
			kind === "touched" ||
			(!isolated &&
				((kind === "changed" && isChangedOnlyArgv(rest) && !changed?.ref) ||
					isRetestOnlyArgv(rest))));
	/** @type {Tree} */
	const frozen = shared ? "shared" : "worktree";
	/** @type {Tree} */
	const settled = full || isolated ? frozen : "shared";
	return {
		rest,
		kind,
		tree: overlaid ? "overlay" : settled,
		fallback: settled,
		escalation: kind === "bare" ? frozen : null,
		source: routeSource({ overlaid, fullShaped, full, changed, rest }),
		sessionId: session,
	};
}

/**
 * Whether the launch is a touched run (workflow-core#2935): a `touched` kind, a `--retest`,
 * or one bounded to the test files it names. It never takes or waits for the
 * whole-suite slot, however many files it resolves to, and waits only on the
 * memory rung for its file count.
 * @param {Pick<LaunchRoute, "kind"|"source"|"rest">} route
 */
const isTouchedRun = (route) =>
	route.kind === "touched" ||
	route.source === "retest" ||
	(route.kind === "named" && runnerTestFileCount(route.rest) !== null);

/**
 * @param {boolean} full
 * @param {boolean} fullShaped
 * @param {ReturnType<typeof changedFlag>} changed
 * @param {boolean} landing
 * @returns {LaunchRoute["kind"]}
 */
function routeKind(full, fullShaped, changed, landing) {
	if (full) return "full";
	if (fullShaped) return landing ? "touched" : "bare";
	return changed ? "changed" : "named";
}

/**
 * @param {{ overlaid: boolean, fullShaped: boolean, full: boolean, changed: ReturnType<typeof changedFlag>, rest: string[] }} route
 * @returns {LaunchRoute["source"]}
 */
function routeSource({ overlaid, fullShaped, full, changed, rest }) {
	if (retestFlag(rest)) return "retest";
	if (overlaid) return "own";
	if (fullShaped) return full ? "full" : "diff";
	if (changed) return "changed";
	return adoptFlag(rest) ? "adopt" : "named";
}

/*
 * NPM TAKES A RUNNER FLAG WRITTEN BEFORE `--` AS ITS OWN CONFIG (workflow-core#2284).
 * `npm run test --queue` sets `npm_config_queue=true` in the script's
 * environment and passes no argument; a word after the flag
 * (`--changed HEAD~1`) arrives as a bare positional. The variable is read only
 * to refuse: a later npm that passes the flag through, or rejects it, needs
 * nothing here. One that drops it silently turns run-vitest.test.ts's
 * `npm run` case red.
 *
 * Residual: an `.npmrc` or exported `npm_config_<flag>` naming one of these
 * reaches every launch too, so each refuses until it goes.
 */
/* The flags whose following words are their value. */
const VALUED_FLAGS = new Set([CHANGED_FLAG, RETEST_FLAG, ADOPT_FLAG]);
const RUNNER_FLAGS = [...WRAPPER_FLAGS, ...VALUED_FLAGS];

/**
 * The refusal for a launch whose runner flags npm swallowed, naming the
 * command that passes them — or null where it swallowed none.
 *
 * The command puts the swallowed flags first and then the argv words the
 * script itself did not bake in, which is where a flag's value landed. Where
 * two swallowed flags each take words, npm lost which word was whose, so the
 * command names a placeholder after each and lists the words apart.
 *
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {string|null}
 */
function npmSwallowedRefusal(argv, env) {
	const swallowed = RUNNER_FLAGS.flatMap((flag) => {
		const value = env[`npm_config_${flag.slice(2)}`];
		if (value === undefined) return [];
		return [{ flag, word: value === "true" ? flag : `${flag}=${value}` }];
	});
	if (swallowed.length === 0) return null;
	const script = (env.npm_lifecycle_script ?? "")
		.split(/\s+/)
		.map((w) => w.replace(/^["']|["']$/g, ""));
	const runner = script.findIndex((w) => w.endsWith("run-vitest.js"));
	const baked = runner === -1 ? 0 : script.length - runner - 1;
	const typed = argv.slice(baked).map(shellWord);
	const takingWords = swallowed.filter(
		({ flag, word }) => VALUED_FLAGS.has(flag) && word === flag,
	);
	const lost = takingWords.length > 1 && typed.length > 0;
	const words = lost
		? swallowed.map(({ flag, word }) =>
				takingWords.some((t) => t.flag === flag) ? `${flag} <its words>` : word,
			)
		: [...swallowed.map(({ word }) => word), ...typed];
	const command = [
		"npm run",
		shellWord(env.npm_lifecycle_event || "test"),
		"--",
		...words,
	].join(" ");
	return (
		`\nNPM TOOK ${swallowed.map(({ word }) => word).join(" ")} — written before \`--\`, npm reads it as its own config and never passes it here, so the run would skip what it asks. Nothing ran. Put \`--\` first:\n\n` +
		`  ${command}\n\n` +
		(lost
			? `npm passed ${typed.join(" ")} with no flag, so which words were whose is lost: put each after its own flag.\n\n`
			: "")
	);
}

module.exports = {
	QUEUE_FLAG,
	FULL_FLAG,
	FULL_PREFIX,
	fullFlagWord,
	stripWrapperFlags,
	isFullRunArgv,
	launchRoute,
	isTouchedRun,
	npmSwallowedRefusal,
};
