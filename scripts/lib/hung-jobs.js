const fs = require("node:fs");
const path = require("node:path");
const { findNewestTranscript } = require("./transcript");
const { configDirs } = require("./arbiter-store");
const { jobStatePath, jobStorePath, rosterPath } = require("./job-paths.js");

/**
 * @typedef {any} JobState
 * @typedef {{seat: string} & ({job: string, unreadable: boolean, rec?: undefined} | {job: string, rec: JobState, unreadable?: undefined})} Job
 * @typedef {{state?: string, sessionId?: string, createdAt?: string, updatedAt?: string, intent?: string, detail?: string, cwd?: string}} JobFields
 * @typedef {{ids: Set<string>, pids: Map<string, number>}} Listed
 * @typedef {{file: string | null, minutes: number | null}} Silence
 * @typedef {{job: string, store: string, sessionId: string, intent: string | null, detail: string | null, cwd: string | null, pid: number | null, minutesQuiet: number, transcript: string | null, reason: string, rosterPath: string}} HungJob
 */

// guess, lucmoseley/mantahostels#2588: longer than any tool call or measured background-job wait
const HUNG_AFTER_MINUTES = 240;

// guess, lucmoseley/mantahostels#2588
const GHOST_AFTER_MINUTES = 30;

/** @returns {string[]} */
function jobSeats() {
	const out = [];
	const seen = new Set();
	for (const seat of configDirs()) {
		const store = jobStorePath(seat);
		let key;
		try {
			key = fs.realpathSync(store);
		} catch {
			key = path.resolve(store);
		}
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(seat);
	}
	return out;
}

const jobStores = () => jobSeats().map(jobStorePath);

/**
 * @param {string} seat
 * @param {string} job
 * @returns {Job | null}
 */
function readJob(seat, job) {
	let raw;
	try {
		raw = fs.readFileSync(jobStatePath(seat, job), "utf8");
	} catch {
		return null;
	}
	let rec;
	try {
		rec = JSON.parse(raw);
	} catch {
		return { seat, job, unreadable: true };
	}
	if (!rec || typeof rec !== "object" || Array.isArray(rec))
		return { seat, job, unreadable: true };
	return { seat, job, rec };
}

/** @returns {Job[] | null} */
function readJobs() {
	/** @type {Job[]} */
	const jobs = [];
	let opened = 0;

	for (const seat of jobSeats()) {
		let entries;
		try {
			entries = fs.readdirSync(jobStorePath(seat), { withFileTypes: true });
		} catch {
			continue;
		}
		opened++;

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const job = readJob(seat, entry.name);
			if (job) jobs.push(job);
		}
	}
	return opened ? jobs : null;
}

/**
 * @param {string} sessionId
 * @returns {Silence}
 */
function transcriptSilence(sessionId) {
	const newest = findNewestTranscript(configDirs(), sessionId);
	return newest
		? {
				file: newest.file,
				minutes: (Date.now() - newest.mtimeMs) / 60_000,
			}
		: { file: null, minutes: null };
}

/**
 * @param {unknown} iso
 * @param {number} [now]
 * @returns {number | null}
 */
function minutesSince(iso, now = Date.now()) {
	if (typeof iso !== "string" || !iso) return null;
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return null;
	return (now - then) / 60_000;
}

/**
 * @param {Array<{sessionId: string, pid?: number}>} agents
 * @returns {(Listed & {why?: undefined}) | {why: string, ids?: undefined, pids?: undefined}}
 */
function livenessOf(agents) {
	const ids = new Set(agents.map((a) => a.sessionId));
	/** @type {Map<string, number>} */
	const pids = new Map();
	for (const a of agents) if (a.pid) pids.set(a.sessionId, a.pid);
	if (agents.length > 0 && pids.size === 0)
		return {
			why: "`claude agents --json` listed agents but not one of them carries a pid — the shape it reports has changed, so a missing pid no longer means a missing process",
		};
	return { ids, pids };
}

/**
 * @param {JobFields & {sessionId: string}} rec
 * @param {Listed} listed
 * @param {number} [minutes]
 * @param {number} [now]
 * @returns {"live" | "young" | {age: number | null, reason: string}}
 */
function ghostTest(
	rec,
	listed,
	minutes = GHOST_AFTER_MINUTES,
	now = Date.now(),
) {
	const { sessionId } = rec;
	if (listed.ids.has(sessionId) && listed.pids.has(sessionId)) return "live";
	const age = minutesSince(rec.updatedAt || rec.createdAt, now);
	if (age !== null && age < minutes) return "young";
	return {
		age,
		reason: listed.ids.has(sessionId)
			? "listed with no process behind it"
			: "not listed at all",
	};
}

/**
 * @param {Array<{seat: string, job: string, rec?: JobFields}>} jobs
 * @param {{live: Set<string>, seats: string[]}} registry
 * @returns {Array<{job: string, seat: string, sessionId: string, intent: string | null, age: number | null}>}
 */
function neverStartedJobs(jobs, { live, seats }) {
	const me = process.env.CLAUDE_CODE_SESSION_ID;
	const read = new Set(seats.map((s) => path.resolve(s)));
	const out = [];
	for (const { seat, job, rec } of jobs) {
		if (!read.has(path.resolve(seat))) continue;
		const sessionId = workingSessionOf(rec, me);
		if (sessionId === null || live.has(sessionId)) continue;
		const age = minutesSince(rec?.updatedAt || rec?.createdAt);
		if (age !== null && age < GHOST_AFTER_MINUTES) continue;
		if (transcriptSilence(sessionId).file !== null) continue;
		out.push({ job, seat, sessionId, intent: stringOrNull(rec?.intent), age });
	}
	return out;
}

/**
 * @param {JobFields | undefined} rec
 * @param {string | undefined} me
 * @returns {string | null}
 */
function workingSessionOf(rec, me) {
	if (rec?.state !== "working") return null;
	const sessionId = rec.sessionId;
	if (typeof sessionId !== "string" || !sessionId) return null;
	if (me && sessionId === me) return null;
	return sessionId;
}

/**
 * @param {JobFields | undefined} rec
 * @param {Listed} listed
 * @param {string | undefined} me
 * @returns {string | null}
 */
function liveWorkingSession(rec, listed, me) {
	const sessionId = workingSessionOf(rec, me);
	if (sessionId === null) return null;
	if (!(listed.ids.has(sessionId) && listed.pids.has(sessionId))) return null;
	return sessionId;
}

/**
 * @param {unknown} v
 * @returns {string | null}
 */
const stringOrNull = (v) => (typeof v === "string" ? v : null);

/**
 * @param {{job: string, seat: string, sessionId: string, rec: JobFields,
 *   pid: number | null, quietFor: number, silence: Silence}} hit
 * @returns {HungJob}
 */
function buildHungJob({ job, seat, sessionId, rec, pid, quietFor, silence }) {
	return {
		job,
		store: jobStorePath(seat),
		sessionId,
		intent: stringOrNull(rec.intent),
		detail: stringOrNull(rec.detail),
		cwd: stringOrNull(rec.cwd),
		pid,
		minutesQuiet: quietFor,
		transcript: silence.file,
		reason: silence.file
			? "listed and alive, but its transcript has not moved"
			: "listed and alive, but it never wrote a transcript",
		rosterPath: rosterPath(seat),
	};
}

/**
 * @param {Array<{seat: string, job: string, unreadable?: boolean, rec?: JobFields}>} jobs
 * @param {Listed} listed
 * @param {{hungMinutes?: number, minutes?: number}} [opts]
 * @returns {HungJob[]}
 */
function findHungJobs(jobs, listed, opts = {}) {
	const hungMinutes = opts.hungMinutes ?? HUNG_AFTER_MINUTES;
	const ghostMinutes = opts.minutes ?? GHOST_AFTER_MINUTES;
	const me = process.env.CLAUDE_CODE_SESSION_ID;
	/** @type {HungJob[]} */
	const hung = [];

	for (const { seat, job, rec } of jobs) {
		const sessionId = liveWorkingSession(rec, listed, me);
		if (!rec || sessionId === null) continue;

		const silence = transcriptSilence(sessionId);
		const quietFor =
			silence.minutes === null ? minutesSince(rec.createdAt) : silence.minutes;
		const window = silence.file ? hungMinutes : ghostMinutes;
		if (quietFor === null || quietFor < window) continue;

		hung.push(
			buildHungJob({
				job,
				seat,
				sessionId,
				rec,
				pid: listed.pids.get(sessionId) ?? null,
				quietFor,
				silence,
			}),
		);
	}
	return hung;
}

module.exports = {
	HUNG_AFTER_MINUTES,
	GHOST_AFTER_MINUTES,
	jobStores,
	readJobs,
	livenessOf,
	ghostTest,
	neverStartedJobs,
	findHungJobs,
};
