/*
 * parked.js — the `parked` label and its session marker (#2000, spec #1995).
 * The label says the issue waits on the founder, on a question round its
 * session posted or on a session the refill loop stopped whatever its cause.
 * An away-mode loop never launches it; a normal-mode one resumes the session
 * that parked it ahead of new work (lib/refill-decide.js, #3621). pick-next.js
 * lists it under PARKED and may still choose it (#2703).
 *
 * WRITERS: park-on-round.js applies it at Stop; refill-loop.js on a park it
 * stops (#2699), commenting the cause on the issue (#2846). unpark-on-prompt.js
 * removes it when the founder types in a session either parked (#3584), and
 * claim-issue.js when a session claims the issue.
 *
 * The session marker, `.parked-<session id>` under the markers directory,
 * lists the issues parked for this session — by park-on-round.js, or by the
 * refill loop where it stopped the session, into that session's checkout — so
 * unpark-on-prompt.js acts off a local read and makes no GitHub call on an
 * ordinary prompt. It also names the seat and job the session ran in, written
 * at park time, which a normal-mode loop resumes it from whoever launched it
 * (#3709). One entry a line: `seat <config dir>`, `job <job id>`, or an issue
 * number.
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseErrLine, gh } = require("./gh.js");
const { markersDir } = require("./marker-root.js");
const { requiredGroup } = require("./regex-group.js");

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

/** @typedef {{seat: string, jobId: string}} ParkJob */
/** @typedef {{issues: number[], job: ParkJob|null}} ParkMarker */

const MARKER_PREFIX = ".parked-";
const KEYED_RE = /^(seat|job) (\S+)$/;
/* park-blocked.sh's record shares the prefix (lib/arbiter-markers.js). */
const BLOCKED_PREFIX = ".parked-blocked-";

/**
 * @param {string} sessionId
 * @param {string} [root]  the session's checkout; the caller's host by default
 */
const markerOf = (sessionId, root) =>
	path.join(markersDir(root), `${MARKER_PREFIX}${sessionId}`);

/**
 * @param {string} text
 * @returns {ParkMarker}
 */
function parseMarker(text) {
	/** @type {Record<string, string>} */
	const keyed = {};
	const issues = [];
	for (const line of text.split("\n").map((l) => l.trim())) {
		if (/^\d+$/.test(line)) issues.push(Number(line));
		const m = KEYED_RE.exec(line);
		if (m) keyed[requiredGroup(m, 1, KEYED_RE)] = requiredGroup(m, 2, KEYED_RE);
	}
	const { seat, job } = keyed;
	return { issues, job: seat && job ? { seat, jobId: job } : null };
}

/**
 * This session's marker; no issues and no job where none or unreadable.
 * @param {string} sessionId
 * @param {string} [root]
 * @returns {ParkMarker}
 */
function readParkMarker(sessionId, root) {
	try {
		return parseMarker(fs.readFileSync(markerOf(sessionId, root), "utf8"));
	} catch {
		/* Fail open (#2000). */
		return { issues: [], job: null };
	}
}

/**
 * The issues this session parked; [] where none or the marker is unreadable.
 * @param {string} sessionId
 * @param {string} [root]
 */
const readParkedBy = (sessionId, root) =>
	readParkMarker(sessionId, root).issues;

/**
 * Every session marker in `root`'s checkout that lists an issue, with its
 * session and when it was last written; [] where the directory will not read.
 * @param {string} root
 * @returns {(ParkMarker & {sessionId: string, writtenAt: number})[]}
 */
function readParkMarkers(root) {
	const dir = markersDir(root);
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch {
		/* Fail open (#3709): with no marker read, each parked row launches
		 * afresh, logged as no session recorded. */
		return [];
	}
	return names.flatMap((name) => {
		if (!name.startsWith(MARKER_PREFIX) || name.startsWith(BLOCKED_PREFIX))
			return [];
		const sessionId = name.slice(MARKER_PREFIX.length);
		try {
			const writtenAt = fs.statSync(path.join(dir, name)).mtimeMs;
			const marker = readParkMarker(sessionId, root);
			return marker.issues.length > 0
				? [{ ...marker, sessionId, writtenAt }]
				: [];
		} catch {
			/* A marker deleted between the listing and its read: no park
			 * (#3709). */
			return [];
		}
	});
}

/**
 * Write this session's marker in `root`'s checkout: `numbers` its issues,
 * replacing the list, and `job` its job, else the one it already names. An
 * empty list deletes it.
 * @param {string} sessionId
 * @param {number[]} numbers
 * @param {{root?: string, job?: ParkJob|null}} [where]
 */
function writeParkedBy(sessionId, numbers, { root, job = null } = {}) {
	const file = markerOf(sessionId, root);
	if (numbers.length === 0) {
		fs.rmSync(file, { force: true });
		return;
	}
	const kept = job ?? readParkMarker(sessionId, root).job;
	const lines = [
		...(kept ? [`seat ${kept.seat}`, `job ${kept.jobId}`] : []),
		...new Set(numbers),
	];
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

module.exports = {
	PARKED_LABEL,
	readParkMarkers,
	readParkedBy,
	setParked,
	writeParkedBy,
};
