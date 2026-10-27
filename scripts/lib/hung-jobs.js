/*
 * lib/hung-jobs.js — read the local job stores, and pick out a WORKING job
 * that is alive but has gone silent (HUNG-JOB, mantahostels#2588).
 *
 * GHOST-JOB's test (a "working" job with NO live process at all) is here too
 * (workflow-core#1989), as `ghostTest` and `livenessOf`, and the never-started subset the
 * refill loop stops, as `neverStartedJobs` (workflow-core#2467).
 */

const fs = require("node:fs");
const path = require("node:path");
const { findTranscript } = require("./transcript");
const { configDirs } = require("./arbiter-store");
const { jobStatePath, jobStorePath, rosterPath } = require("./job-paths.js");

/**
 * @typedef {any} JobState  a job's parsed state.json, as `JSON.parse` returns
 *   it: untyped because the harness owns its schema and each caller narrows
 *   the fields it reads itself
 * @typedef {{seat: string} & ({job: string, unreadable: boolean,
 *   rec?: undefined} | {job: string, rec: JobState, unreadable?: undefined})}
 *   Job
 * @typedef {{state?: string, sessionId?: string, createdAt?: string,
 *   updatedAt?: string, intent?: string, detail?: string, cwd?: string}} JobFields
 *   the state.json fields `findHungJobs` reads
 * @typedef {{ids: Set<string>, pids: Map<string, number>}} Listed
 * @typedef {{file: string | null, minutes: number | null}} Silence
 * @typedef {{job: string, store: string, sessionId: string,
 *   intent: string | null, detail: string | null, cwd: string | null,
 *   pid: number | null, minutesQuiet: number, transcript: string | null,
 *   reason: string, rosterPath: string}} HungJob
 */

/*
 * The hung window, unmeasured and deliberately hours rather than minutes
 * (mantahostels#2588): a session ended on `waiting:`, or mid-way through a long tool
 * call, writes nothing to its transcript and reads here exactly as a hung one
 * does. Four hours is longer than any single tool call this machine runs and
 * longer than any measured wait for a background job
 * (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/waiting-stall-forensics.md), so the cost of the window is
 * that a job hung at minute one goes unnamed until hour four.
 */
const HUNG_AFTER_MINUTES = 240;

/*
 * The short window: a job with NO transcript at all never took a turn, so
 * nothing healthy looks like that past half an hour (mantahostels#2588) — the same grace
 * window GHOST-JOB gives a spare still being handed out.
 */
const GHOST_AFTER_MINUTES = 30;

/**
 * Every seat on this machine, deduped by its `jobs/` directory's realpath.
 * @returns {string[]}
 */
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

/** Every `jobs/` directory on this machine, deduped by realpath. */
const jobStores = () => jobSeats().map(jobStorePath);

/**
 * One job directory's record: `unreadable` where its state.json will not
 * parse to an object, null where it has no state.json to read.
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

/**
 * Every job record across every store, as an array — or null where not one
 * store would open, which is a different fact from an empty store.
 *
 * A directory with no state.json is skipped in silence: a cleaned job dir is
 * ordinary, and mantahostels#104 forbids reading anything into its absence.
 * @returns {Job[] | null}
 */
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
 * How long a session's transcript has gone unwritten, as `{file, minutes}`.
 *
 * `{file: null, minutes: null}` is a transcript that could not be found under
 * any config dir — three plans run here and a job's session may sit under any
 * of them.
 * @param {string} sessionId
 * @returns {Silence}
 */
function transcriptSilence(sessionId) {
	for (const dir of configDirs()) {
		const file = findTranscript(dir, sessionId);
		if (!file) continue;
		try {
			return {
				file,
				minutes: (Date.now() - fs.statSync(file).mtimeMs) / 60_000,
			};
		} catch {
			/* Found but unstattable — keep looking rather than reading an
			 * unreadable transcript as an absent one. */
		}
	}
	return { file: null, minutes: null };
}

/**
 * Minutes since an ISO timestamp, or null where it will not parse.
 * @param {unknown} iso
 * @returns {number | null}
 */
function minutesSince(iso) {
	if (typeof iso !== "string" || !iso) return null;
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return null;
	return (Date.now() - then) / 60_000;
}

/**
 * A listing's `{ids, pids}` — or `{why}`, where it carries agents but not one
 * pid. `pid` is load-bearing on a field agent-liveness does not guard, so were
 * the oracle to drop or rename it every working job would read as a ghost at
 * once.
 * @param {Array<{sessionId: string, pid?: number}>} agents
 * @returns {(Listed & {why?: undefined})
 *   | {why: string, ids?: undefined, pids?: undefined}}
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
 * GHOST-JOB's test (mantahostels#1495) on one WORKING job's record: "live"
 * where the oracle lists its session with a process, "young" inside the grace
 * window, else the ghost's age and why. A MISSING pid, not a missing record, is
 * the signature, so absent from the listing and listed with nothing behind it
 * both count. An unreadable timestamp is a ghost, not suppressed.
 * @param {JobFields & {sessionId: string}} rec
 * @param {Listed} listed
 * @param {number} [minutes]
 * @returns {"live" | "young" | {age: number | null, reason: string}}
 */
function ghostTest(rec, listed, minutes = GHOST_AFTER_MINUTES) {
	const { sessionId } = rec;
	if (listed.ids.has(sessionId) && listed.pids.has(sessionId)) return "live";
	const age = minutesSince(rec.updatedAt || rec.createdAt);
	if (age !== null && age < minutes) return "young";
	return {
		age,
		reason: listed.ids.has(sessionId)
			? "listed with no process behind it"
			: "not listed at all",
	};
}

/**
 * The WORKING jobs that never started: no live session behind them, past
 * GHOST-JOB's grace (an unreadable timestamp counts as past it, as
 * `ghostTest` counts it), and with no transcript under any config dir — the
 * transcript is what no running session lacks, so a process the live read
 * missed cannot make a live one qualify. Only a job in a store whose seat's
 * registry was read is judged.
 * @param {Array<{seat: string, job: string, rec?: JobFields}>} jobs
 * @param {{live: Set<string>, seats: string[]}} registry  the session ids
 *   with a live process, and the seats whose registry was read
 *   (lib/registry-agents.js)
 * @returns {Array<{job: string, seat: string, sessionId: string,
 *   intent: string | null, age: number | null}>}
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
 * The session a WORKING job runs, where it names one that is not this very
 * session; null otherwise.
 * @param {JobFields | undefined} rec
 * @param {string | undefined} me  this session's id
 * @returns {string | null}
 */
function workingSessionOf(rec, me) {
	if (rec?.state !== "working") return null;
	const sessionId = rec.sessionId;
	if (typeof sessionId !== "string" || !sessionId) return null;
	// This very session, which the oracle need not list yet, and which once
	// listed would read as hung on its own dispatcher's re-read (mantahostels#2598).
	if (me && sessionId === me) return null;
	return sessionId;
}

/**
 * The session a job runs, where the job is WORKING and its session is live
 * and is not this very session; null otherwise.
 * @param {JobFields | undefined} rec
 * @param {Listed} listed
 * @param {string | undefined} me  this session's id
 * @returns {string | null}
 */
function liveWorkingSession(rec, listed, me) {
	const sessionId = workingSessionOf(rec, me);
	if (sessionId === null) return null;
	// Live means the oracle both lists it AND can name a process for it —
	// anything short of that is GHOST-JOB territory, not this reader's.
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
 * The WORKING jobs that are alive but silent, off an already-read job list
 * and an already-listed agent set — no oracle call of its own, since
 * its callers already hold a listing (mantahostels#2598).
 *
 * @param {Array<{seat: string, job: string,
 *   unreadable?: boolean, rec?: JobFields}>} jobs
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
		/*
		 * SILENCE IS THE WHOLE TEST, and a transcript-less job is aged from
		 * `createdAt`: `updatedAt` is REWRITTEN while the session runs
		 * (mantahostels#2588), so it gates neither the silence nor the age.
		 */
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
