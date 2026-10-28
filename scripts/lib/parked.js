/*
 * parked.js — the `parked` label (#2000, spec #1995): the issue waits on the
 * founder, on a question round its session posted or on a session the refill
 * loop stopped whatever its cause, so the loop never launches it
 * (lib/refill-decide.js); pick-next.js lists it under PARKED and may still
 * choose it (#2703).
 *
 * WRITERS: park-on-round.js applies it at Stop; refill-loop.js on a park it
 * stops (#2699), commenting the cause on the issue (#2846). unpark-on-prompt.js
 * removes it when the founder types in a session park-on-round.js parked, and
 * claim-issue.js when a session claims the issue.
 *
 * The session marker those two hooks share is lib/parked-marker.js's.
 */

const { parseErrLine, gh } = require("./gh.js");

const PARKED_LABEL = "parked";

/**
 * Put the label on `n`, or take it off. Null on success, else gh's reason.
 * @param {string} repo
 * @param {number} n
 * @param {boolean} on
 */
function setParked(repo, n, on) {
	try {
		gh([
			"issue",
			"edit",
			String(n),
			"--repo",
			repo,
			on ? "--add-label" : "--remove-label",
			PARKED_LABEL,
		]);
		return null;
	} catch (e) {
		return parseErrLine(e);
	}
}

module.exports = {
	PARKED_LABEL,
	setParked,
};
