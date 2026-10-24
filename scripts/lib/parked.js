/*
 * parked.js — the `parked` label (workflow-core#2000, spec workflow-core#1995): a question round on
 * the issue waits on the founder's answer, so selection skips it and lists it
 * under PARKED (pick-next.js).
 *
 * WRITERS: park-on-round.js applies it at Stop; unpark-on-prompt.js removes
 * it when the founder types in the parked session, and claim-issue.js when a
 * session claims the issue.
 *
 * THE SESSION MARKER, `.parked-<session id>` under the markers directory,
 * lists the issues this session parked, so the prompt hook acts off a local
 * read and makes no GitHub call on an ordinary prompt.
 */

const fs = require("node:fs");
const path = require("node:path");
const { errLine, gh } = require("./gh.js");
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
		return errLine(e);
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
function parkedBy(sessionId) {
	try {
		return fs
			.readFileSync(markerOf(sessionId), "utf8")
			.split(/\s+/)
			.filter((t) => /^\d+$/.test(t))
			.map(Number);
	} catch {
		/* Fail open (workflow-core#2000). */
		return [];
	}
}

/**
 * Record the issues this session holds parked, replacing the list; an empty
 * list deletes the marker.
 * @param {string} sessionId
 * @param {number[]} numbers
 */
function markParked(sessionId, numbers) {
	const file = markerOf(sessionId);
	if (numbers.length === 0) fs.rmSync(file, { force: true });
	else fs.writeFileSync(file, `${[...new Set(numbers)].join("\n")}\n`);
}

module.exports = {
	PARKED_LABEL,
	markParked,
	parkedBy,
	setParked,
};
