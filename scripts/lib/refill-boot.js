/*
 * refill-boot.js — whether `refill-loop.js boot-resume` restarts the loop after
 * a distro restart, of any cause (#3878, ruled at #3199), and the line that
 * says why. `refill-loop.js stop` stays the one way to stop it, and the resume
 * writes no control, so it never moves what `start` recorded. Also what the ticks
 * after it trust of the listing while its killed launches come back (#3880), and
 * which jobs the never-started stop spares until they are queued (#3983). And
 * whether a loop just spawned, by a boot or a `start`, came to hold the lock
 * (#4083).
 *
 * `boot-resume` runs at each start of the user manager, so on the manager's
 * restart within a boot too (#3963), which sessions in `/init.scope` outlive; and
 * where `watch` restarts the unit over a dead loop (#4139), which all its sessions
 * outlive.
 */

const {
	isBootKillable,
	isBootKillCandidate,
	isBootKilled,
	isHeld,
	isLive,
	LISTING_GRACE_MS,
	queueBootKilled,
} = require("./refill-blocks.js");
const { recordedStop } = require("./refill-loop.js");

/* First guesses, and stated as ones: the 3 Nov boot's loop reached its lock in
 * 61 ms, so 30 s allows for a machine far busier than a boot was; a poll costs
 * a few small reads of the pidfile and /proc. */
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
 * @param {import("./refill-loop.js").LoopState["stopped"]} found.stopped
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
 * @param {import("./refill-loop.js").LoopState} state
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
		seen.now - Math.max(l.launchedAt, l.relaunchedAt ?? 0) < LISTING_GRACE_MS &&
		!isInRegistry(l, registry);
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
 * @param {import("./refill-loop.js").LoopState} state
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
 * Whether the loop last held its pidfile on the boot now running, so a
 * `boot-resume` is a restart within it and no boot; false where either
 * boot is unknown.
 * @param {string|null|undefined} recorded
 * @param {string|null} current
 */
const isSameBoot = (recorded, current) =>
	current !== null && recorded === current;

/**
 * `state` as `boot-resume` leaves it for the loop it is about to start.
 * @param {import("./refill-loop.js").LoopState} state
 * @param {string|null} current this boot's id
 * @param {number} at
 * @returns {import("./refill-loop.js").LoopState}
 */
const resumedState = (state, current, at) => ({
	...state,
	bootedAt: at,
	sameBootRestart: isSameBoot(state.bootId, current) || undefined,
	heldAt: null,
});

/**
 * `state` as the restart a surviving loop's marker reports leaves it (#3971). The
 * tick queues what the restart killed as after a boot.
 * @param {import("./refill-loop.js").LoopState} state
 * @param {import("./refill-files.js").ManagerRestart|null} marker
 * @param {string|null} current this boot's id
 * @returns {import("./refill-loop.js").LoopState}
 */
const withManagerRestart = (state, marker, current) =>
	marker !== null && isSameBoot(marker.bootId, current)
		? { ...state, bootedAt: marker.at, sameBootRestart: true }
		: state;

/**
 * The jobs the never-started stop spares (#3983): until a listing has read, the
 * launches a restart may have killed, as a stop would write `stopped` on the record
 * and the boot's queueing would read that as ended on its own. Any other job was
 * never due back, and a queued launch is resumed whatever its record reads. Unbounded
 * in time: a spared job has no process, so it holds no memory, and admission charges
 * only what a listing names.
 * @param {import("./refill-loop.js").LoopState} state
 * @returns {Set<string>}
 */
const bootSparedJobs = ({ bootedAt, launches }) =>
	new Set(
		bootedAt === undefined
			? []
			: launches.filter(isBootKillCandidate).map((l) => l.jobId),
	);

module.exports = {
	awaitLoopHold,
	bootSparedJobs,
	bootVerdictOf,
	isEmptyListingTrusted,
	isSameBoot,
	resumedState,
	settleBootKilled,
	withManagerRestart,
};
