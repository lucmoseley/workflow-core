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
 * removes it when the founder types in a session either parked (#3584),
 * claim-issue.js when a session claims the issue, and the refill loop when the
 * session has left the listing having taken a turn since the park that left it
 * unblocked, the only sign a `!` answer leaves (#3940), and on every closed issue,
 * whatever route closed it.
 *
 * The session marker, `.parked-<session id>` under the markers directory,
 * lists the issues parked for this session — by park-on-round.js, or by the
 * refill loop where it stopped the session, into that session's checkout — so
 * unpark-on-prompt.js acts off a local read and makes no GitHub call on an
 * ordinary prompt. It also names the seat, job and directory the session ran
 * in, written at park time, which a normal-mode loop resumes it from whoever
 * launched it (#3709), with no read of a job record that may be torn or gone
 * by then (#3773). A park at a limit cap also counts those parks in a row, which
 * ends the loop's relaunches (#3804); any other write of the marker drops the
 * count, so a question or the founder's typing starts it again. Nothing rewrites
 * a marker at the cap while it holds, so its write time is the hold's start,
 * which the idle alarm reads whatever the loop's mode or state (#3840). One entry a
 * line: `seat <config dir>`, `job <job id>`, `cwd <directory>`,
 * `limit-parks <count>`, or an issue number.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { parseErrLine, gh, ghIssueListAll } = require("./gh.js");
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

/**
 * `cwd` null where the job's record would not read at park time.
 * @typedef {{seat: string, jobId: string, cwd: string|null}} ParkJob
 */
/**
 * @typedef {{issues: number[], job: ParkJob|null, limitParks?: number}} ParkMarker
 */

/**
 * @typedef {ParkMarker & {sessionId: string, writtenAt: number}} ParkMarkerRead
 */

const MARKER_PREFIX = ".parked-";
const KEYED_RE = /^(seat|job|cwd|limit-parks) (.+)$/;
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
	const { seat, job, cwd, "limit-parks": limitParks } = keyed;
	return {
		issues,
		job: seat && job ? { seat, jobId: job, cwd: cwd ?? null } : null,
		...(limitParks ? { limitParks: Number(limitParks) } : {}),
	};
}

/** @param {string} file */
const readMarkerFile = (file) => parseMarker(fs.readFileSync(file, "utf8"));

/**
 * This session's marker; no issues and no job where none or unreadable.
 * @param {string} sessionId
 * @param {string} [root]
 * @returns {ParkMarker}
 */
function readParkMarker(sessionId, root) {
	try {
		return readMarkerFile(markerOf(sessionId, root));
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
 * session and when it was last written. A marker deleted between the listing
 * and its read is no park (#3709); `onUnreadable` answers for one that exists
 * and will not read. Throws where the directory will not read.
 * @param {string} root
 * @param {(err: unknown) => ParkMarkerRead[]} onUnreadable
 * @returns {ParkMarkerRead[]}
 */
function scanParkMarkers(root, onUnreadable) {
	const dir = markersDir(root);
	return fs.readdirSync(dir).flatMap((name) => {
		if (!name.startsWith(MARKER_PREFIX) || name.startsWith(BLOCKED_PREFIX))
			return [];
		const file = path.join(dir, name);
		try {
			const writtenAt = fs.statSync(file).mtimeMs;
			const marker = readMarkerFile(file);
			return marker.issues.length > 0
				? [
						{
							...marker,
							sessionId: name.slice(MARKER_PREFIX.length),
							writtenAt,
						},
					]
				: [];
		} catch (err) {
			return caught(err).code === "ENOENT" ? [] : onUnreadable(err);
		}
	});
}

/**
 * The markers for the idle alarm, which must not read a marker or directory
 * that will not read as no hold (#3840, #3893): either throws.
 * @param {string} root
 * @returns {ParkMarkerRead[]}
 */
const readParkMarkersOrThrow = (root) =>
	scanParkMarkers(root, (err) => {
		throw err;
	});

/**
 * The markers for the loop, leaving out what will not read.
 * @param {string} root
 * @returns {ParkMarkerRead[]}
 */
function readParkMarkers(root) {
	try {
		/* One marker that will not read costs only its own row a fresh launch
		 * (#3893). */
		return scanParkMarkers(root, () => []);
	} catch {
		/* Fail open (#3709): with no marker read, each parked row launches
		 * afresh, logged as no session recorded. */
		return [];
	}
}

/**
 * The newest written of `markers` that lists `number`: the park that holds it
 * now, where several sessions have parked it.
 * @template {{issues: number[], writtenAt: number}} M
 * @param {M[]} markers
 * @param {number} number
 * @returns {M|undefined}
 */
const newestMarkerListing = (markers, number) =>
	markers
		.filter((m) => m.issues.includes(number))
		.sort((x, y) => y.writtenAt - x.writtenAt)[0];

/**
 * Write this session's marker in `root`'s checkout: `numbers` its issues,
 * replacing the list, and `job` its job, else the one it already names, as is
 * its cwd where `job` read none, and `limitParks` its limit-cap parks in a row.
 * An empty list deletes it.
 * @param {string} sessionId
 * @param {number[]} numbers
 * @param {{root?: string, job?: ParkJob|null, limitParks?: number}} [where]
 */
function writeParkedBy(
	sessionId,
	numbers,
	{ root, job = null, limitParks } = {},
) {
	const file = markerOf(sessionId, root);
	if (numbers.length === 0) {
		fs.rmSync(file, { force: true });
		return;
	}
	const prior = readParkMarker(sessionId, root).job;
	const kept = job ? { ...job, cwd: job.cwd ?? prior?.cwd ?? null } : prior;
	const lines = [
		...(kept ? [`seat ${kept.seat}`, `job ${kept.jobId}`] : []),
		...(kept?.cwd ? [`cwd ${kept.cwd}`] : []),
		...(limitParks ? [`limit-parks ${limitParks}`] : []),
		...new Set(numbers),
	];
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

/**
 * Take `parked` off each of `numbers`; each it would not come off, with why.
 * @param {string} repo
 * @param {number[]} numbers
 */
const labelsOff = (repo, numbers) =>
	numbers.flatMap((n) => {
		const why = setParked(repo, n, false);
		return why === null ? [] : [{ n, why }];
	});

/**
 * Take `parked` off each of `numbers` and out of this session's marker; an issue
 * whose label write fails stays in the marker.
 * @param {string} repo
 * @param {string} sessionId
 * @param {number[]} numbers
 * @param {string} [root]  the session's checkout; the caller's host by default
 * @returns {{n: number, why: string}[]} each that failed
 */
function unparkIssues(repo, sessionId, numbers, root) {
	const failed = labelsOff(repo, numbers);
	const gone = numbers.filter((n) => !failed.some((f) => f.n === n));
	writeParkedBy(
		sessionId,
		readParkedBy(sessionId, root).filter((n) => !gone.includes(n)),
		{ root },
	);
	return failed;
}

/**
 * Take `parked` off every closed issue in `repo` that still carries it (#3940):
 * nothing waits on a closed issue, and no one close route covers the web UI and
 * `gh api`. A closed issue's marker stays, as no reader looks one up but for a
 * parked row. Throws where the list will not read.
 * @param {string} repo
 * @returns {{cleared: number[], failed: {n: number, why: string}[]}}
 */
function unparkClosed(repo) {
	const numbers = ghIssueListAll("closed parked issues", [
		"--repo",
		repo,
		"--state",
		"closed",
		"--label",
		PARKED_LABEL,
		"--json",
		"number",
	]).map((/** @type {{number: number}} */ i) => i.number);
	const failed = labelsOff(repo, numbers);
	return {
		cleared: numbers.filter((n) => !failed.some((f) => f.n === n)),
		failed,
	};
}

module.exports = {
	PARKED_LABEL,
	readParkMarkersOrThrow,
	newestMarkerListing,
	readParkMarkers,
	readParkedBy,
	setParked,
	unparkClosed,
	unparkIssues,
	writeParkedBy,
};
