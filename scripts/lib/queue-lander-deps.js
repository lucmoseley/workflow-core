/*
 * queue-lander-deps.js — one queue lander run's dependencies, wired for a
 * checkout: lib/queue-lander.js's runQueueLander over the production adapters
 * (lib/queue-lander-adapters.js), the tester .claude/workflow-core.json's
 * `landingTester` names, the tracker that config names, and the guard-code
 * adoption and levelling pass after each move of `main`.
 *
 * scripts/queue-lander.js runs on it; a test drives the same wiring with its
 * own suite slot handed in as `admit`.
 */

const path = require("node:path");
const { queueTester } = require("./actions-tester.js");
const { baseRedFiler } = require("./base-red-issue.js");
const { parseErrorText } = require("./caught.js");
const { now } = require("./check.js");
const { dropTicketFiler, liveFilerDeps } = require("./fix-ticket.js");
const { adoptGuardCodeAt, adoptionLine } = require("./guard-code.js");
const {
	fileLedger,
	heartbeatWriter,
	landerLock,
	queueLanderFiles,
} = require("./lander-files.js");
const { execGit } = require("./git.js");
const { short } = require("./lander-git.js");
const { levelNow, startLevelling } = require("./level-main.js");
const { commandTester, localTester } = require("./local-tester.js");
const { liveQueueDeps } = require("./queue-issue.js");
const {
	batchRecord,
	dropRecord,
	queueGit,
	queueLogger,
	refusedRecord,
	verdictLedger,
} = require("./queue-lander-adapters.js");
const { buildQueueActionLine } = require("./queue-lander.js");
const { readConfig } = require("./workflow-core-config.js");

/**
 * @typedef {import("./local-tester.js").LocalTesterOptions["admit"]} Admit
 * @typedef {object} LanderWiring
 * @property {string} [tester] a `<command> <sha> [<file>…]` run in place of
 *   the configured tester
 * @property {Admit} [admit] the local tester's suite slot; absent, the
 *   machine's suite gate
 * @property {(line: string) => void} say
 * @property {RunCode} [code] the code this run executes; absent, this
 *   module's own checkout
 */

/**
 * The tester `landingTester` names: the Actions one for `actions`, else the
 * local one, taking its suite slot from `admit`.
 * @param {string} root
 * @param {Admit} [admit]
 * @returns {import("./queue-lander.js").QueueTester}
 */
const configuredTester = (root, admit) =>
	readConfig({ root, quiet: true }).landingTester === "actions"
		? queueTester({ root })
		: localTester({ root, admit });

/**
 * The code a run executes, where it is the landed checkout's own: that
 * checkout's HEAD at the run's start, and the files it has loaded so far,
 * relative to it. `sha` is null where the run executes other code, as a
 * plugin cache's, which no landing changes.
 * @typedef {{sha: string|null, loaded: () => string[]}} RunCode
 */

/**
 * @param {string} root the checkout the run lands
 * @returns {RunCode}
 */
function readRunCode(root) {
	const inside = (/** @type {string} */ f) =>
		f.startsWith(`${root}${path.sep}`);
	return {
		sha: inside(__filename)
			? execGit(["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
			: null,
		loaded: () =>
			Object.keys(require.cache)
				.filter(inside)
				.map((f) => path.relative(root, f)),
	};
}

/**
 * The files this run loaded that `sha` changes.
 * @param {string} root
 * @param {RunCode} code
 * @param {string} sha
 * @returns {string[]}
 */
function readSupersededFiles(root, code, sha) {
	if (code.sha === null) return [];
	const changed = new Set(
		execGit(["diff", "--name-only", code.sha, sha], {
			cwd: root,
			encoding: "utf8",
		})
			.split("\n")
			.filter(Boolean),
	);
	return code.loaded().filter((f) => changed.has(f));
}

/**
 * Whether `root`'s working tree holds each of `files` as `sha` does.
 * @param {string} root
 * @param {string} sha
 * @param {readonly string[]} files
 */
const carriesFiles = (root, sha, files) =>
	execGit(["diff", "--name-only", sha, "--", ...files], {
		cwd: root,
		encoding: "utf8",
	}).trim() === "";

/**
 * After each move of `main` to `sha`: the guard code's adoption and a
 * levelling pass. Where `sha` changed the code this run loaded, the pass is
 * waited for, and true is returned once the checkout carries those files;
 * else it runs detached, as an `npm ci` in it may outlast the next landing.
 * @param {string} root
 * @param {(line: string) => void} say
 * @param {RunCode} code
 * @param {string} sha
 * @returns {boolean}
 */
function afterMainMove(root, say, code, sha) {
	const adoption = adoptGuardCodeAt(root, { fetch: false });
	if (adoption) say(adoptionLine(adoption));
	const files = readSupersededFiles(root, code, sha);
	if (files.length === 0) {
		startLevelling(root, (err) =>
			say(`levelling not started: ${parseErrorText(err)}`),
		);
		return false;
	}
	const failed = levelNow(root);
	const carried = carriesFiles(root, sha, files);
	if (!carried)
		say(
			`${short(sha)} changes this lander's own code, which the checkout does not carry yet; it runs on${failed ? `: ${failed}` : ""}`,
		);
	return carried;
}

/**
 * @param {string} root
 * @returns {import("./queue-lander.js").QueueTracker}
 */
function trackerOf(root) {
	const deps = liveFilerDeps(root);
	return {
		...dropTicketFiler(deps),
		...baseRedFiler(liveQueueDeps(root)),
		stateOf: deps.stateOf,
	};
}

/**
 * @param {string} root the canonical checkout
 * @param {LanderWiring} wiring
 * @returns {import("./queue-lander.js").QueueLanderDeps}
 */
function buildLanderDeps(
	root,
	{ tester, admit, say, code = readRunCode(root) },
) {
	const files = queueLanderFiles(root);
	return {
		git: queueGit(root),
		tester:
			tester === undefined
				? configuredTester(root, admit)
				: commandTester(tester, root),
		ledger: fileLedger(files.ledger),
		verdicts: verdictLedger(files.verdicts),
		refused: refusedRecord(files.refused),
		record: batchRecord(files.batch),
		drops: dropRecord(files.drops),
		tracker: trackerOf(root),
		logQueue: queueLogger(root),
		lock: landerLock(root),
		beat: heartbeatWriter(files.heartbeat),
		log: (action) =>
			say(`${new Date(now()).toISOString()} ${buildQueueActionLine(action)}`),
		mainMoved: (sha) => afterMainMove(root, say, code, sha),
		now,
		say,
	};
}

module.exports = {
	buildLanderDeps,
	carriesFiles,
	readRunCode,
	readSupersededFiles,
};
