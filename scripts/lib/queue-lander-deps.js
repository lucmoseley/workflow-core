const { adopterTester, queueTester } = require("./actions-tester.js");
const { baseRedFiler } = require("./base-red-issue.js");
const { parseErrorText } = require("./caught.js");
const { now } = require("./check.js");
const { dropTicketFiler, liveFilerDeps } = require("./fix-ticket.js");
const { adoptGuardCodeAt, adoptionLine } = require("./guard-code.js");
const {
	fileLedger,
	beatingBefore,
	heartbeatWriter,
	landerLock,
	queueLanderFiles,
} = require("./lander-files.js");
const { short } = require("./lander-git.js");
const { readRunCode, readSupersededFiles } = require("./lander-code.js");
const { startLevelling } = require("./level-main.js");
const {
	commandTester,
	localTester,
	readWholeRuns,
} = require("./local-tester.js");
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

/* A guess, #5468. */
const ACTIONS_OVER_S = 180;
/* A guess, #5524. */
const MEDIAN_RUNS = 20;
/* A guess, #5524. */
const MIN_RUNS = 5;

/**
 * @param {string} root
 * @returns {{median: number|null, runs: number, fault: string|null}}
 */
function readMedianRun(root) {
	let whole;
	try {
		whole = readWholeRuns(root);
	} catch (err) {
		return { median: null, runs: 0, fault: parseErrorText(err) };
	}
	const seconds = whole
		.slice(0, MEDIAN_RUNS)
		.map((r) => r.suiteSeconds)
		.sort((a, b) => a - b);
	const n = seconds.length;
	if (n < MIN_RUNS) return { median: null, runs: n, fault: null };
	const middle = seconds.slice(Math.floor((n - 1) / 2), Math.floor(n / 2) + 1);
	const median = middle.reduce((a, b) => a + b, 0) / middle.length;
	return { median, runs: n, fault: null };
}

/**
 * @param {string} root
 * @param {Admit|undefined} admit
 * @param {(line: string) => void} say
 * @param {() => void} beat
 * @returns {import("./queue-lander.js").QueueTester}
 */
function configuredTester(root, admit, say, beat) {
	const pinned = readConfig({ root, quiet: true }).landingTester;
	if (pinned === "actions") {
		say("tester: actions, as landingTester pins it");
		return queueTester({ root });
	}
	const local = localTester({ root, admit, beat });
	if (pinned === "local") {
		say("tester: local, as landingTester pins it");
		return local;
	}
	const { median, runs, fault } = readMedianRun(root);
	const onActions = median !== null && median > ACTIONS_OVER_S;
	let read = `the median whole run ${Math.round(median ?? 0)} s over the newest ${runs}`;
	if (fault !== null) read = `the run record will not read (${fault})`;
	else if (median === null)
		read = `${runs} whole run(s) recorded, under the ${MIN_RUNS} a median needs`;
	say(
		`tester: ${onActions ? "actions" : "local"}, ${read} (Actions over ${ACTIONS_OVER_S} s)`,
	);
	return onActions ? adopterTester({ root, fallback: local, say }) : local;
}

/**
 * @param {string} root
 * @param {{say: (line: string) => void, code: RunCode|null,
 *   beat: () => void}} run
 * @param {string} sha
 * @returns {boolean}
 */
function afterMainMove(root, { say, code, beat }, sha) {
	beat();
	const adoption = adoptGuardCodeAt(root, { fetch: false });
	if (adoption) say(adoptionLine(adoption));
	beat();
	startLevelling(root, (err) =>
		say(`levelling not started: ${parseErrorText(err)}`),
	);
	if (code === null) return false;
	beat();
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
 * @param {() => void} beat
 * @returns {import("./queue-lander.js").QueueTracker}
 */
function trackerOf(root, beat) {
	const deps = beatingBefore(beat, liveFilerDeps(root));
	return {
		...dropTicketFiler(deps),
		...baseRedFiler(beatingBefore(beat, liveQueueDeps(root))),
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
	const beat = heartbeatWriter(files.heartbeat);
	const built =
		tester === undefined
			? configuredTester(root, admit, say, beat)
			: commandTester(tester, root);
	return {
		git: queueGit(root, {
			ciRepeats: built.repeatsGates === true,
			suiteRepeats: built.repeatsSuite === true,
			beat,
		}),
		tester: built,
		ledger: fileLedger(files.ledger),
		verdicts: verdictLedger(files.verdicts),
		refused: refusedRecord(files.refused),
		record: pipelineRecord(files.batch, now),
		drops: dropRecord(files.drops),
		tracker: trackerOf(root, beat),
		logQueue: queueLogger(root),
		landings: () =>
			readQueueRows(queueLogFile(root))
				.filter((r) => r.event === "land" && isQueueHead(r.ref))
				.map((r) => ({ name: queueNameOf(r.ref), at: r.at })),
		owningSessionStateOf: (name) => readOwningSessionState(root, name),
		lock: landerLock(root),
		beat,
		log: (action) =>
			say(`${new Date(now()).toISOString()} ${buildQueueActionLine(action)}`),
		mainMoved: (sha) => afterMainMove(root, { say, code, beat }, sha),
		now,
		say,
	};
}

module.exports = { buildLanderDeps };
