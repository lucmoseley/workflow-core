/*
 * refill-boot.js — whether `refill-loop.js boot-resume` restarts the loop after
 * a distro restart, of any cause (#3878, ruled at #3199), and the line that
 * says why. `refill-loop.js stop` stays the one way to stop it, and the resume
 * writes no control, so it never moves what `start` recorded. Also what the ticks
 * after it trust of the listing while its killed launches come back (#3880), and
 * which jobs the never-started stop spares until they are queued (#3983). And
 * whether a loop just spawned, by a boot or a `start`, came to hold the lock
 * (#4083).
 */

const {
	isBootKillCandidate,
	isBootKilled,
	isHeld,
	isLive,
} = require("./refill-blocks.js");
const { recordedStop } = require("./refill-loop.js");

/* First guesses, and stated as ones: the 3 Nov boot's loop reached its lock in
 * 61 ms, so 30 s allows for a machine far busier than a boot was; a poll costs
 * two small reads. */
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
		if (!isAlive()) {
			if (held !== null) return `pid ${held} holds ${file}`;
			return hasHeld() ? null : `the loop exited without holding ${file}`;
		}
		if (now() > deadline)
			return `the loop did not hold ${file} within ${LOOP_HOLD_WAIT_MS / 1000} s`;
		sleep(LOOP_HOLD_POLL_MS);
	}
}

/**
 * @param {object} found
 * @param {import("./refill-loop.js").Control|null} found.control
 * @param {string|null} found.damaged why the control would not read
 * @param {import("./refill-loop.js").LoopState["stopped"]} found.stopped
 * @param {number|null} found.pid the pidfile's live holder
 * @param {number} found.self this process's pid, which a stale pidfile can name
 * @returns {{resume: boolean, line: string}}
 */
function bootVerdictOf({ control, damaged, stopped, pid, self }) {
	const refused = (/** @type {string} */ why) => ({
		resume: false,
		line: `boot resume: not resumed: ${why}`,
	});
	if (pid !== null && pid !== self)
		return refused(`already running, pid ${pid}`);
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
 * Whether a tick may read an empty listing as nothing live: the boot's own tick,
 * and, while killed launches wait, any tick with no session it set running, so the
 * listing has nothing it must name. Once one is running, an empty listing is the
 * daemon's fault again (agent-liveness.js).
 * @param {import("./refill-loop.js").LoopState} state
 */
const isEmptyListingTrusted = ({ bootedAt, launches }) =>
	bootedAt !== undefined ||
	(launches.some(isBootKilled) && launches.filter(isLive).every(isHeld));

/**
 * The jobs the never-started stop spares (#3983): until a listing has read, the
 * launches a restart may have killed, as a stop would write `stopped` on the record
 * and the boot's queueing would read that as ended on its own. Any other job was
 * never due back, and a queued launch is resumed whatever its record reads. Unbounded
 * in time: a spared job has no process, so it holds no memory, and an unread listing
 * refuses admission, so its charge binds nothing until the read that ends the spare.
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
};
