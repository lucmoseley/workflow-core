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
const { short } = require("./lander-git.js");
const { readRunCode, readSupersededFiles } = require("./lander-code.js");
const { startLevelling } = require("./level-main.js");
const { commandTester, localTester } = require("./local-tester.js");
const { liveQueueDeps } = require("./queue-issue.js");
const { dropRecord, pipelineRecord } = require("./lander-records.js");
const { isQueueHead, queueNameOf } = require("./landing-refs.js");
const { queueLogFile, readQueueRows } = require("./queue-log.js");
const { readOwningSessionState } = require("./queue-owning-session.js");
const {
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
 * @property {string} [tester]
 * @property {Admit} [admit]
 * @property {(line: string) => void} say
 * @property {RunCode|null} [code]
 * @typedef {import("./lander-code.js").RunCode} RunCode
 */

/**
 * @param {string} root
 * @param {Admit} [admit]
 * @returns {import("./queue-lander.js").QueueTester}
 */
const configuredTester = (root, admit) =>
	readConfig({ root, quiet: true }).landingTester === "actions"
		? queueTester({ root })
		: localTester({ root, admit });

/**
 * @param {string} root
 * @param {(line: string) => void} say
 * @param {RunCode|null} code
 * @param {string} sha
 * @returns {boolean}
 */
function afterMainMove(root, say, code, sha) {
	const adoption = adoptGuardCodeAt(root, { fetch: false });
	if (adoption) say(adoptionLine(adoption));
	startLevelling(root, (err) =>
		say(`levelling not started: ${parseErrorText(err)}`),
	);
	if (code === null) return false;
	try {
		return readSupersededFiles(root, code, sha).length > 0;
	} catch (err) {
		say(
			`whether ${short(sha)} changes this lander's own code went unread, so it runs on: ${parseErrorText(err)}`,
		);
		return false;
	}
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
 * @param {string} root
 * @param {LanderWiring} wiring
 * @returns {import("./queue-lander.js").QueueLanderDeps}
 */
function buildLanderDeps(
	root,
	{ tester, admit, say, code = readRunCode(root) },
) {
	const files = queueLanderFiles(root);
	const built =
		tester === undefined
			? configuredTester(root, admit)
			: commandTester(tester, root);
	return {
		git: queueGit(root, {
			ciRepeats: built.repeatsGates === true,
			suiteRepeats: built.repeatsSuite === true,
		}),
		tester: built,
		ledger: fileLedger(files.ledger),
		verdicts: verdictLedger(files.verdicts),
		refused: refusedRecord(files.refused),
		record: pipelineRecord(files.batch, now),
		drops: dropRecord(files.drops),
		tracker: trackerOf(root),
		logQueue: queueLogger(root),
		landings: () =>
			readQueueRows(queueLogFile(root))
				.filter((r) => r.event === "land" && isQueueHead(r.ref))
				.map((r) => ({ name: queueNameOf(r.ref), at: r.at })),
		owningSessionStateOf: (name) => readOwningSessionState(root, name),
		lock: landerLock(root),
		beat: heartbeatWriter(files.heartbeat),
		log: (action) =>
			say(`${new Date(now()).toISOString()} ${buildQueueActionLine(action)}`),
		mainMoved: (sha) => afterMainMove(root, say, code, sha),
		now,
		say,
	};
}

module.exports = { buildLanderDeps };
