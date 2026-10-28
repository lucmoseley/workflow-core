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
 * THE SESSION MARKER, `.parked-<session id>` under the markers directory,
 * lists the issues park-on-round.js parked for this session, so the prompt
 * hook acts off a local read and makes no GitHub call on an ordinary prompt.
 * A loop-stopped park writes none.
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseErrLine, gh } = require("./gh.js");
const { markersDir } = require("./marker-root.js");

const PARKED_LABEL = "parked";
/* arbiter-markers.js sweeps it, by a copy of this literal. */
const MARKER_PREFIX = ".parked-";

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

/** @param {string} sessionId */
const markerOf = (sessionId) =>
	path.join(markersDir(), `${MARKER_PREFIX}${sessionId}`);

/**
 * The issues this session parked; [] where none or the marker is unreadable.
 * @param {string} sessionId
 * @returns {number[]}
 */
function readParkedBy(sessionId) {
	try {
		return fs
			.readFileSync(markerOf(sessionId), "utf8")
			.split(/\s+/)
			.filter((t) => /^\d+$/.test(t))
			.map(Number);
	} catch {
		/* Fail open (#2000). */
		return [];
	}
}

/**
 * Record the issues this session holds parked, replacing the list; an empty
 * list deletes the marker.
 * @param {string} sessionId
 * @param {number[]} numbers
 */
function writeParkedBy(sessionId, numbers) {
	const file = markerOf(sessionId);
	if (numbers.length === 0) fs.rmSync(file, { force: true });
	else fs.writeFileSync(file, `${[...new Set(numbers)].join("\n")}\n`);
}

module.exports = {
	PARKED_LABEL,
	writeParkedBy,
	readParkedBy,
	setParked,
};
