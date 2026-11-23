const {
	NO_RESPONSE_TEXT,
	SYNTHETIC_MODEL,
	syntheticStopAt,
} = require("./block-cause.js");
const { SYNTHETIC_QUIET_MS, SYNTHETIC_TRIES } = require("./block-act.js");
const { listIssueClaims } = require("./arbiter-issue-claims.js");
const {
	OUTSIDE_FILE,
	REFILL_STATE_FILE,
	refillPath,
} = require("./refill-dir.js");
const { readJsonOutcome } = require("./refill-json.js");
const { FALLBACK_MS } = require("./refill-wake.js");
const { readTail } = require("./file-read.js");
const { read: readTranscript } = require("./session-transcript.js");
const { mainChainRecords } = require("./transcript.js");

const SYNTHETIC_AFTER_MINUTES = (SYNTHETIC_QUIET_MS + FALLBACK_MS) / 60_000;
// guess: a synthetic record and the rows after it fit well inside, #5324
const TAIL_BYTES = 64 * 1024;
const TAIL_NEEDLES = [JSON.stringify(SYNTHETIC_MODEL), NO_RESPONSE_TEXT];

/**
 * @typedef {import("./hung-jobs.js").Job} Job
 * @typedef {{job: string, sessionId: string, name: string, at: number,
 *   issues: number[]|null, loop: string}} SyntheticJob
 */

/** @param {string} file */
function readEnd(file) {
	const tail = readTail(file, TAIL_BYTES);
	return tail.state === "read" ? tail.data.text : null;
}

/**
 * @param {Record<string, unknown>} rec
 * @returns {number|null}
 */
function stopAtOf(rec) {
	const file = rec.linkScanPath;
	if (typeof file !== "string") return null;
	const tail = readEnd(file);
	if (!tail || !TAIL_NEEDLES.every((n) => tail.includes(n))) return null;
	let rows;
	try {
		rows = [...mainChainRecords(readTranscript(file), "main")];
	} catch {
		return null;
	}
	const at = syntheticStopAt({ job: rec, rows });
	return typeof at === "number" ? at : null;
}

/** @param {unknown} list @returns {unknown[]} */
const listOrNone = (list) => (Array.isArray(list) ? list : []);

function readLaunchRecords() {
	const { value } = readJsonOutcome(refillPath(REFILL_STATE_FILE));
	return listOrNone(isObject(value) ? value.launches : null);
}

const readOutsideRecords = () =>
	listOrNone(readJsonOutcome(refillPath(OUTSIDE_FILE)).value);

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => typeof v === "object" && v !== null;

/**
 * @param {string} job
 * @param {number} at
 * @param {unknown[]} records
 */
function loopNoteOf(job, at, records) {
	const rec = records
		.filter(isObject)
		.filter((r) => r.jobId === job)
		.map((r) => r.synthetic)
		.find((s) => isObject(s) && s.at === at);
	const tries = isObject(rec) && typeof rec.tries === "number" ? rec.tries : 0;
	if (!tries) return "the refill loop has not resumed it";
	if ((isObject(rec) && rec.spent) || tries >= SYNTHETIC_TRIES)
		return `the refill loop's ${SYNTHETIC_TRIES} resumes of it are spent`;
	return `the refill loop has resumed it ${tries} of ${SYNTHETIC_TRIES} times`;
}

/**
 * @param {string} sessionId
 * @param {unknown} cwd
 * @returns {number[]|null}
 */
function claimedIssuesOf(sessionId, cwd) {
	try {
		const listed = listIssueClaims(typeof cwd === "string" ? cwd : undefined);
		if (!listed || listed.why) return null;
		return listed.claims
			.filter((c) => c?.sessionId === sessionId && typeof c.issue === "number")
			.map((c) => c.issue)
			.sort((a, b) => a - b);
	} catch {
		return null;
	}
}

/**
 * @param {Job[]} jobs
 * @param {{now: number}} opts
 * @returns {SyntheticJob[]}
 */
function findSyntheticStops(jobs, { now }) {
	/** @type {SyntheticJob[]} */
	const found = [];
	/** @type {unknown[]|undefined} */
	let records;
	for (const { job, rec } of jobs) {
		if (!rec || (rec.state !== "done" && rec.state !== "stopped")) continue;
		const { sessionId } = rec;
		if (typeof sessionId !== "string" || !sessionId) continue;
		const at = stopAtOf(rec);
		if (at === null || now - at < SYNTHETIC_AFTER_MINUTES * 60_000) continue;
		records ??= [...readLaunchRecords(), ...readOutsideRecords()];
		found.push({
			job,
			sessionId,
			name: typeof rec.name === "string" ? rec.name : job,
			at,
			issues: claimedIssuesOf(sessionId, rec.cwd),
			loop: loopNoteOf(job, at, records),
		});
	}
	return found;
}

module.exports = { SYNTHETIC_AFTER_MINUTES, findSyntheticStops };
