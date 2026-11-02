/*
 * refill-boot.js — whether `refill-loop.js boot-resume` restarts the loop after
 * a distro restart, of any cause (#3878, ruled at #3199), and the line that
 * says why. `refill-loop.js stop` stays the one way to stop it, and the resume
 * writes no control, so it never moves what `start` recorded.
 */

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

module.exports = { bootVerdictOf };
