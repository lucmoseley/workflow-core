const { shellQuote } = require("./sh-quote.js");
const { RETEST_FLAG } = require("./test-pass-marker.js");
const { JS_TEST_FILE } = require("./test-kind.js");
const { runnerTestFileCount } = require("./suite-bounded.js");
const {
	ADOPT_FLAG,
	CHANGED_FLAG,
	adoptFlag,
	changedFlag,
	retestFlag,
} = require("./changed-selection.js");

const QUEUE_FLAG = "--queue";

const ISOLATED_FLAG = "--isolated";

const SHARED_FLAG = "--shared";

const FULL_FLAG = "--full";

const FULL_PREFIX = "--full=";

/**
 * @param {string[]} argv
 * @returns {string|null}
 */
function fullFlagWord(argv) {
	return argv.find((w) => w === FULL_FLAG || w.startsWith(FULL_PREFIX)) ?? null;
}

const FRESH_FLAG = "--fresh";

const WRAPPER_FLAGS = new Set([
	QUEUE_FLAG,
	ISOLATED_FLAG,
	SHARED_FLAG,
	FULL_FLAG,
	FRESH_FLAG,
]);

/**
 * @param {string[]} argv
 * @returns {string[]}
 */
function stripWrapperFlags(argv) {
	return argv.filter(
		(word) => !WRAPPER_FLAGS.has(word) && !word.startsWith(FULL_PREFIX),
	);
}

const NAME_FILTER_FLAGS = new Set(["-t", "--testNamePattern"]);

/**
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

/** @typedef {"snapshot"|"worktree"|"shared"} Tree */

/**
 * @typedef {object} LaunchRoute
 * @property {string[]} rest
 * @property {"full"|"touched"|"changed"|"named"} kind
 * @property {Tree} tree
 * @property {Tree} fallback
 * @property {"full"|"diff"|"own"|"changed"|"adopt"|"retest"|"named"} source
 * @property {string|null} sessionId
 */

/**
 * @param {string[]} argv
 * @param {string|null} sessionId
 * @returns {LaunchRoute}
 */
function launchRoute(argv, sessionId) {
	const rest = stripWrapperFlags(argv);
	const shared = argv.includes(SHARED_FLAG);
	const isolated = !shared && argv.includes(ISOLATED_FLAG);
	const full = fullFlagWord(argv) !== null;
	const fullShaped = isFullRunArgv(rest);
	const changed = changedFlag(rest);
	const session = sessionId || null;
	const kind = routeKind(full, fullShaped, changed);
	const own = !shared && session !== null && kind === "touched";
	/** @type {Tree} */
	const frozen = shared ? "shared" : "worktree";
	/** @type {Tree} */
	const settled = full || isolated ? frozen : "shared";
	const snapshot = !shared && !isolated && !full && session !== null;
	return {
		rest,
		kind,
		tree: snapshot ? "snapshot" : settled,
		fallback: settled,
		source: routeSource({ own, fullShaped, full, changed, rest }),
		sessionId: session,
	};
}

/**
 * @param {string[]} argv
 * @returns {boolean}
 */
const isSnapshotArgv = (argv) =>
	!argv.includes(SHARED_FLAG) &&
	!argv.includes(ISOLATED_FLAG) &&
	fullFlagWord(argv) === null;

/**
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
 * @returns {LaunchRoute["kind"]}
 */
function routeKind(full, fullShaped, changed) {
	if (full) return "full";
	if (fullShaped) return "touched";
	return changed ? "changed" : "named";
}

/**
 * @param {{ own: boolean, fullShaped: boolean, full: boolean, changed: ReturnType<typeof changedFlag>, rest: string[] }} route
 * @returns {LaunchRoute["source"]}
 */
function routeSource({ own, fullShaped, full, changed, rest }) {
	if (retestFlag(rest)) return "retest";
	if (own) return "own";
	if (fullShaped) return full ? "full" : "diff";
	if (changed) return "changed";
	return adoptFlag(rest) ? "adopt" : "named";
}

const VALUED_FLAGS = new Set([CHANGED_FLAG, RETEST_FLAG, ADOPT_FLAG]);
const RUNNER_FLAGS = [...WRAPPER_FLAGS, ...VALUED_FLAGS];

/**
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
	const typed = argv.slice(baked).map(shellQuote);
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
		shellQuote(env.npm_lifecycle_event || "test"),
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

const NO_CACHE_FLAG = "--no-cache";

/**
 * @param {string[]} argv
 * @returns {string|null}
 */
function noCacheRefusal(argv) {
	return argv.includes(NO_CACHE_FLAG)
		? `\n${NO_CACHE_FLAG} is vitest's own flag: the pass store would still skip the files it holds a pass for. Nothing ran. To run every selected file, pass ${FRESH_FLAG}.\n\n`
		: null;
}

/**
 * @param {Pick<LaunchRoute, "kind"|"source">} route
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 */
const isPassStoreLaunch = (route, argv, env = process.env) =>
	route.kind !== "full" &&
	route.source !== "retest" &&
	!argv.includes(FRESH_FLAG) &&
	!env.WFC_VERDICT_PROBE;

module.exports = {
	isPassStoreLaunch,
	QUEUE_FLAG,
	ISOLATED_FLAG,
	SHARED_FLAG,
	FULL_FLAG,
	FULL_PREFIX,
	fullFlagWord,
	stripWrapperFlags,
	isFullRunArgv,
	launchRoute,
	isSnapshotArgv,
	isTouchedRun,
	noCacheRefusal,
	npmSwallowedRefusal,
};
