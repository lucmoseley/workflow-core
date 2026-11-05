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
const { startLevelling } = require("./level-main.js");
const { commandTester, localTester } = require("./local-tester.js");
const { liveQueueDeps } = require("./queue-issue.js");
const {
	batchRecord,
	dropRecord,
	queueGit,
	queueLogger,
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
 * After each move of `main`: the guard code's adoption and a levelling pass.
 * @param {string} root
 * @param {(line: string) => void} say
 * @returns {void}
 */
function afterMainMove(root, say) {
	const adoption = adoptGuardCodeAt(root, { fetch: false });
	if (adoption) say(adoptionLine(adoption));
	startLevelling(root, (err) =>
		say(`levelling not started: ${parseErrorText(err)}`),
	);
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
function buildLanderDeps(root, { tester, admit, say }) {
	const files = queueLanderFiles(root);
	return {
		git: queueGit(root),
		tester:
			tester === undefined
				? configuredTester(root, admit)
				: commandTester(tester, root),
		ledger: fileLedger(files.ledger),
		verdicts: verdictLedger(files.verdicts),
		record: batchRecord(files.batch),
		drops: dropRecord(files.drops),
		tracker: trackerOf(root),
		logQueue: queueLogger(root),
		lock: landerLock(root),
		beat: heartbeatWriter(files.heartbeat),
		log: (action) =>
			say(`${new Date(now()).toISOString()} ${buildQueueActionLine(action)}`),
		mainMoved: () => afterMainMove(root, say),
		now,
		say,
	};
}

module.exports = { buildLanderDeps };
