/*
 * parked-marker.js — the session marker, `.parked-<session id>` under the
 * markers directory, listing the issues park-on-round.js parked for this
 * session, so unpark-on-prompt.js acts off a local read and makes no GitHub
 * call on an ordinary prompt. A loop-stopped park writes none.
 *
 * Apart from lib/parked.js so arbiter-markers.js can sweep it by this
 * MARKER_PREFIX: parked.js requires gh.js, which the arbiter's require graph
 * refuses (#3372).
 */

const fs = require("node:fs");
const path = require("node:path");
const { markersDir } = require("./marker-root.js");

const MARKER_PREFIX = ".parked-";

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
	MARKER_PREFIX,
	readParkedBy,
	writeParkedBy,
};
