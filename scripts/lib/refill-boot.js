/*
 * refill-boot.js — whether `refill-loop.js boot-resume` restarts the loop after
 * a distro restart, of any cause (#3878, ruled at #3199), and the line that
 * says why. `refill-loop.js stop` stays the one way to stop it, and the resume
 * writes no control, so it never moves what `start` recorded. Also what the ticks
 * after it trust of the listing while its killed launches come back (#3880), and
 * which jobs the never-started stop spares until they are queued (#3983). And
 * whether a loop just spawned, by a boot or a `start`, came to hold the lock
 * (#4083). And what `boot-resume`, `watch` and `run` write and return around
 * that verdict and that lock (#4356). And which launches a manager restart's
 * marker reopens, and when a restart's wait on the listing alarms (#4145).
 *
 * `boot-resume` runs at each start of the user manager, so on the manager's
 * restart within a boot too (#3963), which sessions in `/init.scope` outlive; and
 * where `watch` restarts the unit over a dead loop (#4139), which all its sessions
 * outlive.
 */

const {
	hasJobEnded,
	isBootKillable,
	isBootKillCandidate,
	isBootKilled,
	isHeld,
	isLive,
	launchName,
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

/* First guesses, and stated as ones: 30 s allows for a machine far busier than
 * the one boot measured (#4083); a poll costs a few small reads of the pidfile
 * and /proc. */
const LOOP_HOLD_WAIT_MS = 30_000;
const LOOP_HOLD_POLL_MS = 50;

/**
 * Waits until the spawned loop holds the lock, or has held it and already ended.
 * @param {object} loop
 * @param {number|undefined} loop.pid the spawned process
 * @param {string} loop.file the pidfile, for the words
 * @param {() => number|null} loop.holder the pidfile's live holder
 * @param {() => boolean} loop.hasHeld whether a loop has held it since the launch
 * @param {() => boolean} loop.isAlive whether the spawned process still runs
 * @param {() => number} loop.now a monotonic clock, in ms
 * @param {(ms: number) => void} loop.sleep
 * @returns {string|null} why no loop started; null where one did
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
 * @param {string|null} found.damaged why the control would not read
 * @param {import("./refill-state.js").LoopState["stopped"]} found.stopped
 * @param {number|null} found.pid the pidfile's live holder
 * @param {number} found.self this process's pid, which a stale pidfile can name
 * @returns {{resume: boolean, line: string, tellLoop?: string}}
 *   `tellLoop`, a loop outlived whatever restarted the manager: the line saying
 *   it was told
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
 * Whether the session registry names `l`'s job or session, whose record it keeps
 * only for a process proven live.
 * @param {import("./refill-loop.js").LoopLaunch} l
 * @param {import("./registry-agents.js").RegistryListing} registry
 */
const isInRegistry = (l, registry) =>
	registry.agents.some((a) => a.id === l.jobId || a.sessionId === l.sessionId);

/**
 * The launches with those a restart killed queued, and `bootedAt` gone, once a
 * listing has read; as they were until then. On a same-boot restart (#4139), a
 * launch the registry names is alive, and one inside the listing's grace may not be
 * listed yet, so it waits, `bootedAt` standing, for the tick that grace ends on. Residual:
 * past that grace, a live session both unlisted and unrecorded is queued.
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
 * Whether a tick may read an empty listing as nothing live: the boot's own tick,
 * and, while killed launches wait, any tick with no session it set running, so the
 * listing has nothing it must name. Once one is running, an empty listing is the
 * daemon's fault again (agent-liveness.js). On a same-boot restart a session in
 * `/init.scope` may be running unlisted, so only where the registry also shows
 * every launch it may have killed gone (#3971). Residual: a faulty listing and a
 * live session's missing registry record, together, still queue that session.
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
			(launches.some(isBootKilled) && launches.filter(isLive).every(isHeld));

/**
 * `state` as the restart a surviving loop's marker reports leaves it (#3971). The
 * tick queues what the restart killed as after a boot. A tick between the
 * daemon's death and the marker may have read its sessions gone and finished
 * them, so each the last tick finished for leaving the listing is reopened, bar
 * one whose job record reads it ended on its own (#4145). Residual: a tick past the marker that a kill
 * kept from dropping it hides that last tick, so nothing is reopened.
 * @param {import("./refill-state.js").LoopState} state
 * @param {import("./refill-files.js").ManagerRestart|null} marker
 * @param {string|null} current this boot's id
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

/* A first guess, stated as one: a manager restart's daemon is back within
 * seconds, and the listing's grace (LISTING_GRACE_MS) holds a launch 2 minutes,
 * so a wait several times that is no restart's own. */
const RESTART_WAIT_ALARM_MS = 15 * 60 * 1000;

/**
 * When the restart whose killed launches still wait on a listing began, where
 * that wait has outlasted RESTART_WAIT_ALARM_MS; null otherwise. The idle alarm
 * counts those launches as running meanwhile (#4145).
 * @param {Pick<import("./refill-state.js").LoopState, "bootedAt">} state
 * @param {number} now
 * @returns {number|null}
 */
const restartWaitOf = ({ bootedAt }, now) =>
	bootedAt !== undefined && now - bootedAt >= RESTART_WAIT_ALARM_MS
		? bootedAt
		: null;

/**
 * The jobs the never-started stop spares (#3983): until a listing has read, the
 * launches a restart may have killed, as a stop would write `stopped` on the record
 * and the boot's queueing would read that as ended on its own. Any other job was
 * never due back, and a queued launch is resumed whatever its record reads. Unbounded
 * in time: a spared job has no process, so it holds no memory, and admission charges
 * only what a listing names.
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
 * @typedef {object} BootReads what `boot-resume` and `watch` read
 * @property {(log: Log) => {control: import("./refill-loop.js").Control|null,
 *   damaged: string|null}} readControl
 * @property {(log: Log) => import("./refill-state.js").LoopState} readState
 * @property {() => number|null} holder the pidfile's live holder
 * @property {number} self this process's pid
 */

/**
 * `boot-resume` (#3878): resumes the loop where bootVerdictOf says to. The resume is on the state before the launch, so a
 * loop that dies ahead of its first tick leaves it, and heldAt then says
 * whether the new loop ever held the pidfile; where none did, the last loop's
 * hold is put back, as its death still stands for `status`.
 * @param {BootReads & {
 *   note: Log,
 *   bootId: () => string|null,
 *   now: () => number,
 *   updateState: (t: import("./refill-state.js").Transition) => void,
 *   writeManagerRestart: (at: number) => void,
 *   launch: () => {error: string} | {pid: number|undefined,
 *     fetchError: string|null|undefined},
 * }} io
 * @returns {0|1} the exit code
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
 * `watch` (#4139): restarts the boot unit only where `boot-resume` would
 * resume. Each of its refusals stands until someone acts, so it logs none,
 * which would repeat at every firing; `boot-resume` and `status` name a damaged
 * file. A launch in flight reads as a running loop: a restart would race a
 * `start`, or kill a `boot-resume` mid-fetch.
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
 * `run`'s hold (#3861): once it holds the pidfile, any stop on record is
 * before this run, so cleared, and heldAt says a loop held it.
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
