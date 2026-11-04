/*
 * refill-state.js — the refill loop's state file (#4232, #4213).
 *
 * `readState` is the only read of the file and `updateState` the only write;
 * scripts/refill-wake.sh's `jq` read of its unfinished launches is the one
 * reader outside, a Stop hook kept off Node. Residual: it still sees a
 * malformed row parseState drops, until the loop's next write erases it. A
 * write reads the file fresh and applies a pure transition to it, so a later
 * write in a tick always lands on an earlier one. Each transition owns only the
 * fields it names and spreads the rest, so a new field is one edit, here.
 *
 * NO LOCK. The pidfile serialises the writers: the loop process holds it, and
 * `boot-resume`, `start` and `set` write only once they have found no holder. A
 * writer that writes beside a live holder is a defect.
 *
 * A leaf: it loads no arbiter store, so lib/resume-expected.js, part of the
 * store's marker sweep, reads launches through it.
 */

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
 *   idle?: string|null, planWait?: import("./refill-decide.js").PlanWait}|null}
 *   lastTick `idle` is decideTick's reason it launched nothing, the idle alarm's
 *   source for it (#3920); `planWait` the allowance wait's, absent on any other
 * @property {{at: number, reason: string, detail: string}|null} stopped
 * @property {number|null} [heldAt] ms, when the current run's process took the
 *   pidfile; null from a start until its process does (#3861)
 * @property {Hold[]} held the last frontier-reading tick's, for the idle
 *   alarm (#3680)
 * @property {string|null} reviewRunOn machine-local date of the last morning
 *   review filing
 * @property {LaunchCount|null} launchCount
 * @property {LaunchCount|null} handedOff handedOffSince's, `from` being the away
 *   switch
 * @property {import("./overflow-notice.js").OverflowStart|null} overflowStart
 *   the newest first overflow launch after a plan-seat launch
 * @property {import("./refill-goal.js").GoalProgress|null} goalProgress the last
 *   frontier-reading tick's
 * @property {number} [bootedAt] when `boot-resume` restarted the loop, until a tick
 *   has read its listing and queued the launches the restart killed (#3880)
 * @property {true} [sameBootRestart] that restart was the user manager's within a
 *   boot, for as long as `bootedAt` stands (#3971)
 * @property {string} [bootId] the boot the loop last took the pidfile on (#3971)
 * @property {string[]} probeBrokenRoots the last settled tick's served checkouts
 *   whose probe failed, for the idle alarm: such a failure may leave no hold on
 *   file (#3903)
 * @property {Record<string, number>} seatTriedAt when each seat's `/usage` was
 *   last probed, whatever came of it: a failed probe moves no cache stamp (#4060)
 * @property {Launching} [launching] the batch a tick was launching, which only a
 *   kill leaves on record (#4180)
 */

/**
 * The launches since `from`, the control's noProgressFrom, which outlast the
 * rows keptLaunches trims (#3889).
 * @typedef {{from: number, count: number}} LaunchCount
 */

/**
 * An issue the loop holds, and since when, ms: a parked row on its session's full
 * seat, from the first normal-mode tick of an unbroken run of frontier-reading
 * ticks that held it; or, `onLimit`, a launch waiting on a limit (limitWaitOf).
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
	const idle = typeof raw.idle === "string" ? raw.idle : null;
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
 * The launch rows, each malformed one dropped and logged, failing open as the
 * file's damage does (#4232); none, logged, where the file holds something
 * other than a list of them.
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
 * @param {(line: string) => void} [log] told of each launch row dropped
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
 * The state file, parsed; absent or damaged reads as parseState's defaults, with
 * `log` told of damage and of each launch row dropped.
 * @param {(line: string) => void} log
 * @returns {LoopState}
 */
const readState = (log) => parseState(readJson(stateFile(), log), log);

/**
 * Apply `transition` to a fresh read and write the result; one that hands its
 * state back unchanged writes nothing, so an absent file stays absent.
 * @param {Transition} transition
 * @param {(line: string) => void} log
 * @returns {LoopState} what was written
 */
function updateState(transition, log) {
	const read = readState(log);
	const next = transition(read);
	if (next !== read) writeJson(stateFile(), next);
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
 * The job a launch's dispatch-ledger rows name, which a copy keeps: a launch's
 * identity across writes.
 * @template {string|null} J
 * @param {{copiedFrom?: string, jobId: J}} l
 * @returns {string|J}
 */
const ledgerJobOf = (l) => l.copiedFrom ?? l.jobId;

/**
 * The tick's `launches` laid on `onDisk`, the launches as the file holds them
 * now: the tick's word stands on every launch it read in `read` or carries, and
 * one recorded since its read that it does not carry is kept. A launch is known
 * by its ledger job, so a mid-tick write that replaces a row the tick read
 * stands only where the tick carries the replacement too, as each writeLaunch
 * caller does.
 * @param {LoopLaunch[]} onDisk
 * @param {LoopLaunch[]} read
 * @param {LoopLaunch[]} launches
 */
function mergeLaunches(onDisk, read, launches) {
	const known = new Set([...read, ...launches].map(ledgerJobOf));
	return [...launches, ...onDisk.filter((l) => !known.has(ledgerJobOf(l)))];
}

/**
 * `s` with the tick's `launches` laid on its own (mergeLaunches) and no batch in
 * flight.
 * @param {LoopState} s the fresh read
 * @param {LoopState} read the state the tick started on
 * @param {LoopLaunch[]} launches
 * @returns {LoopState}
 */
const withTickLaunches = (s, read, launches) => ({
	...withoutLaunching(s),
	launches: mergeLaunches(s.launches, read.launches, launches),
});

/**
 * The calling process now holds the pidfile: the last stop no longer describes
 * the loop, and any death from here on is a crash (#3861).
 * @param {number} now
 * @param {string|null} bootId this boot's
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

/**
 * The last process's hold forgotten, before another starts: until the new one
 * holds the pidfile, no process has died (#3861).
 * @returns {Transition}
 */
const runForgotten = () => (s) =>
	s.heldAt === null || s.heldAt === undefined ? s : { ...s, heldAt: null };

/**
 * Whether the loop last held its pidfile on the boot now running, so a
 * `boot-resume` is a restart within it and no boot; false where either
 * boot is unknown.
 * @param {string|null|undefined} recorded
 * @param {string|null} current
 */
const isSameBoot = (recorded, current) =>
	current !== null && recorded === current;

/**
 * `boot-resume` about to start the loop: the restart's time, whether it was the
 * user manager's within this boot (#3971), and no hold until the new loop takes
 * the pidfile.
 * @param {string|null} bootId this boot's
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
 * `boot-resume`'s launch failed: no new loop held the pidfile, so the last one's
 * hold, `heldAt`, stands for `status`.
 * @param {number|null|undefined} heldAt
 * @returns {Transition}
 */
const bootResumeFailed = (heldAt) => (s) => ({ ...s, heldAt });

/**
 * Launch `l` in place of the unfinished one it was, matched by its ledger job,
 * or added where none is (#4180).
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
 * What a kill before the last tick's write left out settled (#4180): `launches`
 * and `launchCount` as the settling left them, from the state it read in `read`,
 * and the cut-off batch no longer in flight.
 * @param {Pick<LoopState, "launches"|"launchCount">} settled
 * @param {LoopState} read
 * @returns {Transition}
 */
const killSettled =
	({ launches, launchCount }, read) =>
	(s) => ({ ...withTickLaunches(s, read, launches), launchCount });

/**
 * @typedef {object} TickOwned the fields a tick writes, from the state it read
 * @property {number} [bootedAt]
 * @property {true} [sameBootRestart]
 */

/**
 * A tick's resumes and launches so far on record before its next launcher runs
 * (#4157, #4180): `launching`, with its count, the batch it is about to launch.
 * @param {LoopLaunch[]} launches
 * @param {LoopState} read the state the tick started on
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
 * A tick settled: the fields a tick owns, the batch it launched no longer in
 * flight, and every other field as the file holds it.
 * @param {Pick<LoopState, "launches"|"lastTick"|"stopped"|"held"|"launchCount"|
 *   "handedOff"|"overflowStart"|"goalProgress"|"probeBrokenRoots"|
 *   "seatTriedAt"> & TickOwned} owned
 * @param {LoopState} read the state the tick started on
 * @returns {Transition}
 */
const tickSettled =
	({ launches, ...owned }, read) =>
	(s) => ({ ...withTickLaunches(s, read, launches), ...owned });

/**
 * After the tick's write: a stop that landed late, and the morning review's
 * filing date.
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
