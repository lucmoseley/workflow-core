const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { parseErrLine, gh, ghIssueListAll } = require("./gh.js");
const { markersDir } = require("./marker-root.js");
const { requiredGroup } = require("./regex-group.js");

const PARKED_LABEL = "parked";

/**
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

/** @typedef {{seat: string, keyVar?: string, jobId: string, cwd: string|null}} ParkJob */
/**
 * @typedef {{issues: number[], job: ParkJob|null, limitParks?: number, cause?: string}} ParkMarker
 */

/**
 * @typedef {ParkMarker & {sessionId: string, writtenAt: number}} ParkMarkerRead
 */

const MARKER_PREFIX = ".parked-";
const KEYED_RE = /^(seat|key|job|cwd|limit-parks|cause) (.+)$/;
const BLOCKED_PREFIX = ".parked-blocked-";

/**
 * @param {string} sessionId
 * @param {string} [root]
 */
const markerOf = (sessionId, root) =>
	path.join(markersDir(root), `${MARKER_PREFIX}${sessionId}`);

/**
 * @param {string} sessionId
 * @param {string} [root]
 */
const blockedRecordOf = (sessionId, root) =>
	path.join(markersDir(root), `${BLOCKED_PREFIX}${sessionId}`);

/**
 * @param {string} sessionId
 * @param {string} [root]
 * @returns {number|null}
 */
function readParkedBlockedIssue(sessionId, root) {
	try {
		const rec = JSON.parse(
			fs.readFileSync(blockedRecordOf(sessionId, root), "utf8"),
		);
		return Number.isInteger(rec?.issue) ? rec.issue : null;
	} catch {
		return null;
	}
}

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
	const { seat, key, job, cwd, "limit-parks": limitParks, cause } = keyed;
	return {
		issues,
		job:
			seat && job
				? {
						seat,
						...(key ? { keyVar: key } : {}),
						jobId: job,
						cwd: cwd ?? null,
					}
				: null,
		...(limitParks ? { limitParks: Number(limitParks) } : {}),
		...(cause ? { cause } : {}),
	};
}

/** @param {string} file */
const readMarkerFile = (file) => parseMarker(fs.readFileSync(file, "utf8"));

/**
 * @param {string} sessionId
 * @param {string} [root]
 * @returns {ParkMarker}
 */
function readParkMarker(sessionId, root) {
	try {
		return readMarkerFile(markerOf(sessionId, root));
	} catch {
		return { issues: [], job: null };
	}
}

/**
 * @param {string} sessionId
 * @param {string} [root]
 */
const readParkedBy = (sessionId, root) =>
	readParkMarker(sessionId, root).issues;

/**
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
 * @param {string} root
 * @returns {ParkMarkerRead[]}
 */
const readParkMarkersOrThrow = (root) =>
	scanParkMarkers(root, (err) => {
		throw err;
	});

/**
 * @param {string} root
 * @returns {ParkMarkerRead[]}
 */
function readParkMarkers(root) {
	try {
		return scanParkMarkers(root, () => []);
	} catch {
		return [];
	}
}

/**
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
 * @param {string} sessionId
 * @param {number[]} numbers
 * @param {{root?: string, job?: ParkJob|null, limitParks?: number, cause?: string}} [where]
 */
function writeParkedBy(
	sessionId,
	numbers,
	{ root, job = null, limitParks, cause } = {},
) {
	const file = markerOf(sessionId, root);
	if (numbers.length === 0) {
		fs.rmSync(file, { force: true });
		return;
	}
	const prior = readParkMarker(sessionId, root).job;
	const kept = job ? { ...job, cwd: job.cwd ?? prior?.cwd ?? null } : prior;
	const lines = [
		...(kept ? [`seat ${kept.seat}`] : []),
		...(kept?.keyVar ? [`key ${kept.keyVar}`] : []),
		...(kept ? [`job ${kept.jobId}`] : []),
		...(kept?.cwd ? [`cwd ${kept.cwd}`] : []),
		...(limitParks ? [`limit-parks ${limitParks}`] : []),
		...(cause ? [`cause ${cause}`] : []),
		...new Set(numbers),
	];
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

/**
 * @param {string} from
 * @param {number[]} issues
 * @param {{root: string, copySessionId: string|null, job: ParkJob}} to
 */
function moveParkedBy(from, issues, { root, copySessionId, job }) {
	const held = readParkedBy(from, root);
	const moved = held.filter((n) => issues.includes(n));
	if (moved.length === 0) return;
	if (copySessionId)
		writeParkedBy(
			copySessionId,
			[...readParkedBy(copySessionId, root), ...moved],
			{ root, job },
		);
	writeParkedBy(
		from,
		held.filter((n) => !moved.includes(n)),
		{ root },
	);
}

/**
 * @param {string} repo
 * @param {number[]} numbers
 */
function takeLabelsOff(repo, numbers) {
	const failed = numbers.flatMap((n) => {
		const why = setParked(repo, n, false);
		return why === null ? [] : [{ n, why }];
	});
	return {
		cleared: numbers.filter((n) => !failed.some((f) => f.n === n)),
		failed,
	};
}

/**
 * @param {string} repo
 * @param {string} sessionId
 * @param {number[]} numbers
 * @param {string} [root]
 * @returns {{n: number, why: string}[]}
 */
function unparkIssues(repo, sessionId, numbers, root) {
	const { cleared, failed } = takeLabelsOff(repo, numbers);
	writeParkedBy(
		sessionId,
		readParkedBy(sessionId, root).filter((n) => !cleared.includes(n)),
		{ root },
	);
	return failed;
}

/**
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
	return takeLabelsOff(repo, numbers);
}

module.exports = {
	blockedRecordOf,
	PARKED_LABEL,
	readParkMarkersOrThrow,
	newestMarkerListing,
	moveParkedBy,
	readParkMarkers,
	readParkedBlockedIssue,
	readParkedBy,
	setParked,
	unparkClosed,
	unparkIssues,
	writeParkedBy,
};
