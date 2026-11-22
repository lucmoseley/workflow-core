const { isHeld, isLive, launchName } = require("./refill-block-core.js");
const {
	hasJobEnded,
	isBootKillable,
	isBootKillCandidate,
	isStepResumeFor,
	LISTING_GRACE_MS,
	queueBootKilled,
} = require("./refill-blocks.js");
const { startedAt } = require("./refill-decide.js");
const { recordedStop } = require("./refill-loop.js");
const {
	bootResumeFailed,
	bootResumed,
	isSameBoot,
	runHeld,
} = require("./refill-state.js");

// guess, #4083
const LOOP_HOLD_WAIT_MS = 30_000;
const LOOP_HOLD_POLL_MS = 50;

/**
 * @param {object} loop
 * @param {number|undefined} loop.pid
 * @param {string} loop.file
 * @param {() => number|null} loop.holder
 * @param {() => boolean} loop.hasHeld
 * @param {() => boolean} loop.isAlive
 * @param {() => number} loop.now
 * @param {(ms: number) => void} loop.sleep
 * @returns {string|null}
 */
function awaitLoopHold({ pid, file, holder, hasHeld, isAlive, now, sleep }) {
	const deadline = now() + LOOP_HOLD_WAIT_MS;
	for (;;) {
		const held = holder();
		if (held === pid) return null;
		const alive = isAlive();
		if (alive && now() <= deadline) {
			sleep(LOOP_HOLD_POLL_MS);
			continue;
		}
		if (held !== null) return `pid ${held} holds ${file}`;
		if (alive)
			return `the loop did not hold ${file} within ${LOOP_HOLD_WAIT_MS / 1000} s`;
		return hasHeld() ? null : `the loop exited without holding ${file}`;
	}
}

/**
 * @param {object} found
 * @param {import("./refill-loop.js").Control|null} found.control
 * @param {string|null} found.damaged
 * @param {import("./refill-state.js").LoopState["stopped"]} found.stopped
 * @param {number|null} found.pid
 * @param {number} found.self
 * @returns {{resume: boolean, line: string, tellLoop?: string}}
 */
function bootVerdictOf({ control, damaged, stopped, pid, self }) {
	const refused = (/** @type {string} */ why) => ({
		resume: false,
		line: `boot resume: not resumed: ${why}`,
	});
	if (pid !== null && pid !== self)
		return {
			...refused(`already running, pid ${pid}`),
			tellLoop: "boot resume: told the running loop the manager restarted",
		};
	if (damaged !== null) return refused(damaged);
	if (control === null) return refused("no start on record");
	const stop = recordedStop(control, stopped);
	if (stop !== null)
		return refused(
			stop.reason === "explicit"
				? "stopped by command"
				: `the loop ended itself: ${stop.detail}`,
		);
	return {
		resume: true,
		line: `boot resume: resumed the loop counting from ${new Date(control.noProgressFrom).toISOString()}`,
	};
}

/**
 * @param {import("./refill-loop.js").LoopLaunch} l
 * @param {import("./registry-agents.js").RegistryListing} registry
 */
const isInRegistry = (l, registry) =>
	registry.agents.some((a) => a.id === l.jobId || a.sessionId === l.sessionId);

/**
 * @param {import("./refill-state.js").LoopState} state
 * @param {Parameters<typeof queueBootKilled>[1]} seen
 * @param {import("./registry-agents.js").RegistryListing} registry
 * @returns {{launches: import("./refill-loop.js").LoopLaunch[], bootedAt?: number,
 *   sameBootRestart?: true}}
 */
function settleBootKilled(
	{ launches, bootedAt, sameBootRestart },
	seen,
	registry,
) {
	if (bootedAt === undefined || seen.agents === null)
		return { launches, bootedAt, sameBootRestart };
	if (!sameBootRestart)
		return { launches: queueBootKilled(launches, seen, bootedAt) };
	const isWaiting = (/** @type {import("./refill-loop.js").LoopLaunch} */ l) =>
		seen.now - startedAt(l) < LISTING_GRACE_MS && !isInRegistry(l, registry);
	const queued = queueBootKilled(
		launches,
		seen,
		bootedAt,
		(l) => isInRegistry(l, registry) || isWaiting(l),
	);
	return launches.some((l) => isWaiting(l) && isBootKillable(l, seen, bootedAt))
		? { launches: queued, bootedAt, sameBootRestart }
		: { launches: queued };
}

/**
 * @param {import("./refill-state.js").LoopState} state
 * @param {import("./registry-agents.js").RegistryListing} registry
 */
const isEmptyListingTrusted = (
	{ bootedAt, sameBootRestart, launches },
	registry,
) =>
	sameBootRestart
		? registry.faults.length === 0 &&
			launches
				.filter(isBootKillCandidate)
				.every(
					(l) => registry.seats.includes(l.seat) && !isInRegistry(l, registry),
				)
		: bootedAt !== undefined ||
			(launches.some((l) => isStepResumeFor(l, "bootKilled")) &&
				launches.filter(isLive).every(isHeld));

/**
 * @param {import("./refill-state.js").LoopState} state
 * @param {import("./refill-files.js").ManagerRestart|null} marker
 * @param {string|null} current
 * @param {Pick<import("./refill-blocks.js").BlockReads, "jobStateOf"|"log">} io
 * @returns {import("./refill-state.js").LoopState}
 */
function withManagerRestart(state, marker, current, io) {
	if (marker === null || !isSameBoot(marker.bootId, current)) return state;
	/** @type {import("./refill-state.js").LoopState} */
	const restarted = { ...state, bootedAt: marker.at, sameBootRestart: true };
	const lastTickAt = state.lastTick?.at;
	if (lastTickAt === undefined || lastTickAt > marker.at) return restarted;
	const launches = state.launches.map((l) => {
		if (!l.leftListing || l.finishedAt === null || l.finishedAt < lastTickAt)
			return l;
		const { leftListing: _, ...rest } = l;
		const reopened = { ...rest, finishedAt: null };
		if (!isBootKillCandidate(reopened) || hasJobEnded(reopened, io)) return l;
		io.log(
			`${launchName(l)}, finished just before a manager restart: reopened`,
		);
		return reopened;
	});
	return { ...restarted, launches };
}

// guess, #4145
const RESTART_WAIT_ALARM_MS = 15 * 60 * 1000;

/**
 * @param {Pick<import("./refill-state.js").LoopState, "bootedAt">} state
 * @param {number} now
 * @returns {number|null}
 */
const restartWaitOf = ({ bootedAt }, now) =>
	bootedAt !== undefined && now - bootedAt >= RESTART_WAIT_ALARM_MS
		? bootedAt
		: null;

/**
 * @param {import("./refill-state.js").LoopState} state
 * @returns {Set<string>}
 */
const bootSparedJobs = ({ bootedAt, launches }) =>
	new Set(
		bootedAt === undefined
			? []
			: launches.filter(isBootKillCandidate).map((l) => l.jobId),
	);

/** @param {string} why */
const buildFetchFailedLine = (why) =>
	`fetch failed, starting on the last fetched tip: ${why}`;

/** @typedef {(line: string) => void} Log */

/**
 * @typedef {object} BootReads
 * @property {(log: Log) => {control: import("./refill-loop.js").Control|null,
 *   damaged: string|null}} readControl
 * @property {(log: Log) => import("./refill-state.js").LoopState} readState
 * @property {() => number|null} holder
 * @property {number} self
 */

/**
 * @param {BootReads & {
 *   note: Log,
 *   bootId: () => string|null,
 *   now: () => number,
 *   updateState: (t: import("./refill-state.js").Transition) => void,
 *   writeManagerRestart: (at: number) => void,
 *   launch: () => {error: string} | {pid: number|undefined,
 *     fetchError: string|null|undefined},
 * }} io
 * @returns {0|1}
 */
function runBootResume(io) {
	const { note } = io;
	const bootId = io.bootId();
	if (bootId === null)
		note(
			"boot resume: this boot's id will not read, so a manager restart reads as a boot (#3971)",
		);
	const { control, damaged } = io.readControl(note);
	const state = io.readState(note);
	const verdict = bootVerdictOf({
		control,
		damaged,
		stopped: state.stopped,
		pid: io.holder(),
		self: io.self,
	});
	if (!verdict.resume) {
		note(verdict.line);
		if (verdict.tellLoop) {
			io.writeManagerRestart(io.now());
			note(verdict.tellLoop);
		}
		return 0;
	}
	io.updateState(bootResumed(bootId, io.now()));
	const launched = io.launch();
	if ("error" in launched) {
		io.updateState(bootResumeFailed(state.heldAt));
		note(`boot resume: not resumed: ${launched.error}`);
		return 1;
	}
	if (launched.fetchError)
		note(`boot resume: ${buildFetchFailedLine(launched.fetchError)}`);
	note(`${verdict.line}, pid ${launched.pid}`);
	return 0;
}

/**
 * @param {BootReads & {
 *   launchHolder: () => number|null,
 *   restartBootUnit: () => {error: string|null},
 * }} io
 * @returns {{code: 0} | {code: 1, message: string}}
 */
function runWatch(io) {
	const quiet = () => undefined;
	const { control, damaged } = io.readControl(quiet);
	const { resume } = bootVerdictOf({
		control,
		damaged,
		stopped: io.readState(quiet).stopped,
		pid: io.holder() ?? io.launchHolder(),
		self: io.self,
	});
	if (!resume) return { code: 0 };
	const { error } = io.restartBootUnit();
	return error === null ? { code: 0 } : { code: 1, message: error };
}

/**
 * @param {{
 *   acquire: () => boolean,
 *   pidFile: string,
 *   log: Log,
 *   now: () => number,
 *   bootId: () => string|null,
 *   updateState: (t: import("./refill-state.js").Transition) => void,
 * }} io
 */
function holdRun(io) {
	if (!io.acquire()) {
		io.log(`another refill loop holds ${io.pidFile}; exiting`);
		return false;
	}
	io.updateState(runHeld(io.now(), io.bootId()));
	return true;
}

module.exports = {
	awaitLoopHold,
	bootSparedJobs,
	bootVerdictOf,
	buildFetchFailedLine,
	holdRun,
	isEmptyListingTrusted,
	restartWaitOf,
	runBootResume,
	runWatch,
	settleBootKilled,
	withManagerRestart,
};
