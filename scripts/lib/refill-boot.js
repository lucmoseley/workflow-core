/*
 * refill-boot.js — whether `refill-loop.js boot-resume` restarts the loop after
 * a distro restart, of any cause (#3878, ruled at #3199), and the line that
 * says why. `refill-loop.js stop` stays the one way to stop it, and the resume
 * writes no control, so it never moves what `start` recorded. Also what the ticks
 * after it trust of the listing while its killed launches come back (#3880), and
 * which jobs the never-started stop spares until they are queued (#3983).
 */

const {
	isBootKillCandidate,
	isBootKilled,
	isHeld,
	isLive,
} = require("./refill-blocks.js");
const { recordedStop } = require("./refill-loop.js");

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

module.exports = { bootSparedJobs, bootVerdictOf, isEmptyListingTrusted };
