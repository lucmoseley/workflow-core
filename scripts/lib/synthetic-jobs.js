/*
 * synthetic-jobs.js — the background jobs the harness ended on its own "No
 * response requested." record (#5322, #5324), for check-ghost-jobs's
 * SYNTHETIC-STOP finding.
 *
 * READS ONLY, AND DEGRADES TO SILENCE: a record, transcript or loop file that
 * will not read names no job. A transcript is parsed only where its tail
 * holds the synthetic record's model and text.
 */

const { syntheticStopAt } = require("./block-cause.js");
const { SYNTHETIC_QUIET_MS, SYNTHETIC_TRIES } = require("./block-act.js");
const { listIssueClaims } = require("./arbiter-issue-claims.js");
const {
	OUTSIDE_FILE,
	REFILL_STATE_FILE,
	refillPath,
} = require("./refill-dir.js");
const { readJsonOutcome } = require("./refill-json.js");
const { readTail } = require("./file-read.js");
const { read: readTranscript } = require("./session-transcript.js");
const { mainChainRecords } = require("./transcript.js");

/* The quiet window before the finding fires: the loop's own, so the loop's
 * resumes come first. */
const SYNTHETIC_AFTER_MINUTES = SYNTHETIC_QUIET_MS / 60_000;
/* How much of a transcript's end the cheap test reads: a synthetic record
 * and the rows after it fit well inside. Untraced. */
const TAIL_BYTES = 64 * 1024;
const TAIL_NEEDLES = ['"<synthetic>"', "No response requested."];

/**
 * @typedef {import("./hung-jobs.js").Job} Job
 * @typedef {{job: string, sessionId: string, name: string, at: number,
 *   issues: number[]|null, loop: string}} SyntheticJob  `issues`, null where
 *   the claim store will not read; `loop`, what the refill loop did with it
 */

/**
 * The last TAIL_BYTES of `file`, or null where it will not read.
 * @param {string} file
 */
function readEnd(file) {
	const tail = readTail(file, TAIL_BYTES);
	return tail.state === "read" ? tail.data.text : null;
}

/**
 * When `rec`'s job was ended on a synthetic reply, ms; null where it was not
 * or will not read.
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

/**
 * @param {string} name
 * @returns {unknown[]}
 */
function readLoopList(name) {
	const { value } = readJsonOutcome(refillPath(name));
	const list =
		name === REFILL_STATE_FILE && isObject(value) ? value.launches : value;
	return Array.isArray(list) ? list : [];
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => typeof v === "object" && v !== null;

/**
 * What the refill loop did with `job`'s stop at `at`, read off its launch
 * records and its outside-session records.
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
 * The issues `sessionId` claims in `cwd`'s checkout, null where its claim
 * store will not read whole.
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
 * The jobs in `jobs` the harness ended on a synthetic reply more than
 * `minutes` before `now`.
 * @param {Job[]} jobs
 * @param {{now: number, minutes?: number}} opts
 * @returns {SyntheticJob[]}
 */
function findSyntheticStops(jobs, { now, minutes = SYNTHETIC_AFTER_MINUTES }) {
	/** @type {SyntheticJob[]} */
	const found = [];
	/** @type {unknown[]|undefined} */
	let records;
	for (const { job, rec } of jobs) {
		if (!rec || (rec.state !== "done" && rec.state !== "stopped")) continue;
		const { sessionId } = rec;
		if (typeof sessionId !== "string" || !sessionId) continue;
		const at = stopAtOf(rec);
		if (at === null || now - at < minutes * 60_000) continue;
		records ??= [
			...readLoopList(REFILL_STATE_FILE),
			...readLoopList(OUTSIDE_FILE),
		];
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
