const { recordJobs } = require("./loop-jobs.js");
const { parseOverflowStart } = require("./overflow-notice.js");
const { REFILL_STATE_FILE, refillPath } = require("./refill-dir.js");
const {
	isRecord,
	parseGoalProgress,
	parseStrings,
} = require("./refill-goal.js");
const { readJson, writeJson } = require("./refill-json.js");

/** @typedef {import("./refill-loop.js").LoopLaunch} LoopLaunch */
/** @typedef {import("./refill-batch.js").Launching} Launching */

/**
 * @typedef {object} LoopState
 * @property {LoopLaunch[]} launches
 * @property {{at: number, summary: string,
 *   skipped?: import("./refill-decide.js").Skip[],
 *   idle?: import("./refill-decide.js").Idle|null, planWait?: import("./refill-decide.js").PlanWait}|null}
 *   lastTick
 * @property {{at: number, reason: string, detail: string}|null} stopped
 * @property {number|null} [heldAt]
 * @property {Hold[]} held
 * @property {string|null} reviewRunOn
 * @property {LaunchCount|null} launchCount
 * @property {LaunchCount|null} handedOff
 * @property {import("./overflow-notice.js").OverflowStart|null} overflowStart
 * @property {import("./refill-goal.js").GoalProgress|null} goalProgress
 * @property {number} [bootedAt]
 * @property {true} [sameBootRestart]
 * @property {string} [bootId]
 * @property {string[]} probeBrokenRoots
 * @property {Record<string, number>} seatTriedAt
 * @property {Launching} [launching]
 */

/** @typedef {{from: number, count: number}} LaunchCount */

/**
 * @typedef {import("./refill-decide.js").Skip & {since: number,
 *   onLimit?: boolean}} Hold
 */

/** @typedef {(state: LoopState) => LoopState} Transition */

const stateFile = () => refillPath(REFILL_STATE_FILE);

/** @param {unknown} raw @returns {Record<string, number>} */
const parseSeatTriedAt = (raw) =>
	Object.fromEntries(
		Object.entries(isRecord(raw) ? raw : {}).flatMap(([seat, at]) =>
			typeof at === "number" ? [[seat, at]] : [],
		),
	);

/** @param {unknown} raw @returns {LoopState["stopped"]} */
function parseStopped(raw) {
	if (
		!isRecord(raw) ||
		typeof raw.at !== "number" ||
		typeof raw.reason !== "string"
	)
		return null;
	return {
		at: raw.at,
		reason: raw.reason,
		detail: typeof raw.detail === "string" ? raw.detail : "",
	};
}

/** @param {unknown} raw */
const isSkip = (raw) =>
	isRecord(raw) &&
	typeof raw.root === "string" &&
	typeof raw.number === "number" &&
	typeof raw.why === "string";

/** @param {unknown} raw @returns {raw is Hold} */
const isHold = (raw) =>
	isRecord(raw) && isSkip(raw) && typeof raw.since === "number";

/** @param {unknown} raw @returns {LoopState["lastTick"]} */
function parseLastTick(raw) {
	if (
		!isRecord(raw) ||
		typeof raw.at !== "number" ||
		typeof raw.summary !== "string"
	)
		return null;
	const skipped = Array.isArray(raw.skipped) ? raw.skipped.filter(isSkip) : [];
	const idle =
		isRecord(raw.idle) &&
		typeof raw.idle.reason === "string" &&
		typeof raw.idle.detail === "string"
			? { reason: raw.idle.reason, detail: raw.idle.detail }
			: null;
	return {
		at: raw.at,
		summary: raw.summary,
		skipped,
		idle,
		...(isRecord(raw.planWait)
			? {
					planWait: {
						resets:
							typeof raw.planWait.resets === "number"
								? raw.planWait.resets
								: null,
					},
				}
			: {}),
	};
}

/** @param {unknown} raw @returns {LaunchCount|null} */
const parseLaunchCount = (raw) =>
	isRecord(raw) && typeof raw.from === "number" && typeof raw.count === "number"
		? { from: raw.from, count: raw.count }
		: null;

/**
 * @param {unknown} raw
 * @returns {raw is Launching}
 */
const isLaunching = (raw) =>
	isRecord(raw) && typeof raw.at === "number" && Array.isArray(raw.batch);

/**
 * @param {unknown} raw
 * @returns {raw is LoopLaunch}
 */
const isLaunch = (raw) =>
	isRecord(raw) &&
	typeof raw.root === "string" &&
	Array.isArray(raw.issues) &&
	typeof raw.prompt === "string" &&
	typeof raw.seat === "string" &&
	typeof raw.launchedAt === "number" &&
	(raw.finishedAt === null || typeof raw.finishedAt === "number") &&
	(raw.jobId === null || typeof raw.jobId === "string");

/**
 * @param {unknown} raw
 * @param {(line: string) => void} log
 * @returns {LoopLaunch[]}
 */
function parseLaunches(raw, log) {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) {
		log(`${stateFile()}: launches is not a list; read as none`);
		return [];
	}
	return raw.filter((l) => {
		if (isLaunch(l)) return true;
		log(`${stateFile()}: dropped a malformed launch row: ${JSON.stringify(l)}`);
		return false;
	});
}

/**
 * @param {unknown} raw
 * @param {(line: string) => void} [log]
 * @returns {LoopState}
 */
function parseState(raw, log = () => undefined) {
	const r = isRecord(raw) ? raw : {};
	return {
		launches: parseLaunches(r.launches, log),
		lastTick: parseLastTick(r.lastTick),
		stopped: parseStopped(r.stopped),
		heldAt: typeof r.heldAt === "number" ? r.heldAt : null,
		held: Array.isArray(r.held) ? r.held.filter(isHold) : [],
		reviewRunOn: typeof r.reviewRunOn === "string" ? r.reviewRunOn : null,
		launchCount: parseLaunchCount(r.launchCount),
		handedOff: parseLaunchCount(r.handedOff),
		overflowStart: parseOverflowStart(r.overflowStart),
		goalProgress: parseGoalProgress(r.goalProgress),
		probeBrokenRoots: parseStrings(r.probeBrokenRoots),
		seatTriedAt: parseSeatTriedAt(r.seatTriedAt),
		...(typeof r.bootedAt === "number" ? { bootedAt: r.bootedAt } : {}),
		...(r.sameBootRestart === true ? { sameBootRestart: true } : {}),
		...(typeof r.bootId === "string" ? { bootId: r.bootId } : {}),
		...(isLaunching(r.launching) ? { launching: r.launching } : {}),
	};
}

/**
 * @param {(line: string) => void} log
 * @returns {LoopState}
 */
const readState = (log) => parseState(readJson(stateFile(), log), log);

/**
 * @param {Transition} transition
 * @param {(line: string) => void} log
 * @returns {LoopState}
 */
function updateState(transition, log) {
	const read = readState(log);
	const next = transition(read);
	if (next === read) return next;
	writeJson(stateFile(), next);
	recordJobs(read.launches, next.launches, { now: Date.now(), log });
	return next;
}

/**
 * @param {LoopState} state
 * @returns {LoopState}
 */
function withoutLaunching(state) {
	const { launching: _, ...rest } = state;
	return rest;
}

/**
 * @template {string|null} J
 * @param {{copiedFrom?: string, jobId: J}} l
 * @returns {string|J}
 */
const ledgerJobOf = (l) => l.copiedFrom ?? l.jobId;

/**
 * @param {LoopLaunch[]} onDisk
 * @param {LoopLaunch[]} read
 * @param {LoopLaunch[]} launches
 */
function mergeLaunches(onDisk, read, launches) {
	const known = new Set([...read, ...launches].map(ledgerJobOf));
	return [...launches, ...onDisk.filter((l) => !known.has(ledgerJobOf(l)))];
}

/**
 * @param {LoopState} s
 * @param {LoopState} read
 * @param {LoopLaunch[]} launches
 * @returns {LoopState}
 */
const withTickLaunches = (s, read, launches) => ({
	...withoutLaunching(s),
	launches: mergeLaunches(s.launches, read.launches, launches),
});

/**
 * @param {number} now
 * @param {string|null} bootId
 * @returns {Transition}
 */
const runHeld = (now, bootId) => (s) => {
	const { bootId: _, ...rest } = s;
	return {
		...rest,
		stopped: null,
		heldAt: now,
		...(bootId === null ? {} : { bootId }),
	};
};

/** @returns {Transition} */
const runForgotten = () => (s) =>
	s.heldAt === null || s.heldAt === undefined ? s : { ...s, heldAt: null };

/**
 * @param {string|null|undefined} recorded
 * @param {string|null} current
 */
const isSameBoot = (recorded, current) =>
	current !== null && recorded === current;

/**
 * @param {string|null} bootId
 * @param {number} at
 * @returns {Transition}
 */
const bootResumed = (bootId, at) => (s) => {
	const { sameBootRestart: _, ...rest } = s;
	return {
		...rest,
		bootedAt: at,
		...(isSameBoot(s.bootId, bootId) ? { sameBootRestart: true } : {}),
		heldAt: null,
	};
};

/**
 * @param {number|null|undefined} heldAt
 * @returns {Transition}
 */
const bootResumeFailed = (heldAt) => (s) => ({ ...s, heldAt });

/**
 * @param {LoopLaunch} l
 * @returns {Transition}
 */
const launchRecorded = (l) => (s) => {
	const job = ledgerJobOf(l);
	/** @param {LoopLaunch} x */
	const isIt = (x) => x.finishedAt === null && ledgerJobOf(x) === job;
	return {
		...s,
		launches: s.launches.some(isIt)
			? s.launches.map((x) => (isIt(x) ? l : x))
			: [...s.launches, l],
	};
};

/**
 * @param {Pick<LoopState, "launches"|"launchCount">} settled
 * @param {LoopState} read
 * @returns {Transition}
 */
const killSettled =
	({ launches, launchCount }, read) =>
	(s) => ({ ...withTickLaunches(s, read, launches), launchCount });

/**
 * @typedef {object} TickOwned
 * @property {number} [bootedAt]
 * @property {true} [sameBootRestart]
 */

/**
 * @param {LoopLaunch[]} launches
 * @param {LoopState} read
 * @param {TickOwned & {inFlight?: Pick<LoopState, "launchCount"> &
 *   {launching: Launching}}} owned
 * @returns {Transition}
 */
const batchLaunching =
	(launches, read, { bootedAt, sameBootRestart, inFlight }) =>
	(s) => ({
		...withTickLaunches(s, read, launches),
		bootedAt,
		sameBootRestart,
		...inFlight,
	});

/**
 * @param {Pick<LoopState, "launches"|"lastTick"|"stopped"|"held"|"launchCount"|
 *   "handedOff"|"overflowStart"|"goalProgress"|"probeBrokenRoots"|
 *   "seatTriedAt"> & TickOwned} owned
 * @param {LoopState} read
 * @returns {Transition}
 */
const tickSettled =
	({ launches, ...owned }, read) =>
	(s) => ({ ...withTickLaunches(s, read, launches), ...owned });

/**
 * @param {LoopState["stopped"]} stopped
 * @param {string|null} reviewRunOn
 * @returns {Transition}
 */
const lateStopped = (stopped, reviewRunOn) => (s) => ({
	...s,
	stopped,
	reviewRunOn,
});

module.exports = {
	batchLaunching,
	bootResumeFailed,
	bootResumed,
	isSameBoot,
	killSettled,
	lateStopped,
	launchRecorded,
	ledgerJobOf,
	readState,
	runForgotten,
	runHeld,
	tickSettled,
	updateState,
	withoutLaunching,
};
