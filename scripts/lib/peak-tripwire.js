/*
 * peak-tripwire.js — the switch that sends every part-suite back to the
 * ladder once earlyoom kills a test run while a peak-charged run is live
 * (#5367, spec #5366): `armed` lets the gate charge a part-suite on its own
 * measured peak, `tripped` holds it on the ladder until a session that has
 * read the kill re-arms it (scripts/peak-tripwire.js `arm`).
 *
 * THE STATE is one JSON file, TRIPWIRE_FILE in the canonical checkout's
 * markers directory, written atomically. Absent, it reads `armed` (#5362).
 *
 * THE TRIP RULE: a kill in or after the `checkedThrough` cursor's second, the
 * journal's resolution, trips the wire where lib/earlyoom-kills.js's reader
 * joins it to a test run and any run file (lib/run-memory.js) carrying
 * `mode: "peak"` was live at its time: started at or before the kill's second,
 * last sampled no more than the store's slack before it. The run files are
 * machine-wide, so any repo's peak run counts.
 *
 * THROTTLED: the journal is read at most once per CHECK_MS, by the state's
 * `checkedAt`; between checks the gate reads the file alone, so a hook pays no
 * journal read on most calls.
 *
 * BLIND FAILS TO THE LADDER: a journal the reader reports unreadable, or a run
 * store that will not read beside a test-run kill, records `unread` and keeps
 * the cursor; the gate judges part-suites on the ladder until a readable check
 * clears it. A state file that will not parse, or a check that will not
 * write it, falls to the ladder too, as `state-unread`, and only `arm`
 * rewrites a torn file, so a torn trip is never lost to a check.
 *
 * The gate's reads never throw; `arm` throws where the file will not write.
 */

const path = require("node:path");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught } = require("./caught.js");
const { readText } = require("./file-read.js");
const { hostRoot } = require("./host-root.js");
const { toSecond } = require("./journalctl.js");
const { markersDir } = require("./marker-root.js");
const { heldUntil } = require("./run-memory.js");
const { scriptPath } = require("./script-path.js");

const TRIPWIRE_FILE = "peak-tripwire.json";
/* Untraced (#5366 §Values). */
const CHECK_MS = 30 * 1000;

/**
 * @typedef {{ at: string, pid: number, name: string, rssMiB: number,
 *   testRun: import("./earlyoom-kills.js").TestRun }} Trip
 * @typedef {{ at: string, session: string|null, kind: string,
 *   fileCount: number, repo: string }} LiveRun
 * @typedef {object} Tripwire
 * @property {"armed"|"tripped"} state
 * @property {Trip|null} trip the kill that tripped it
 * @property {LiveRun[]} liveRuns the peak-charged runs live at that kill
 * @property {string|null} trippedAt
 * @property {string|null} checkedThrough the journal read through, ISO
 * @property {string|null} checkedAt the last check, readable or not
 * @property {{ at: string, why: string }|null} unread the last check, where
 *   it could not read; cleared by a readable one
 * @property {string|null} armedBy the session that last re-armed it
 * @property {string|null} armedAt
 * @typedef {{ tripwire: Tripwire, corrupt: string|null }} Read
 * @typedef {{ cause: "tripped"|"journal-unread"|"state-unread", why?: string }} Fallback
 * @typedef {(sinceMs: number) => { incidents: import("./earlyoom-kills.js").Incident[], why: string|null }} IncidentReader
 * @typedef {() => { runs: (import("./run-memory.js").RunFile & { mode?: string })[], why: string|null }} RunReader
 * @typedef {(what: string, detail?: string) => void} Log
 */

/** @type {Tripwire} */
const ARMED = {
	state: "armed",
	trip: null,
	liveRuns: [],
	trippedAt: null,
	checkedThrough: null,
	checkedAt: null,
	unread: null,
	armedBy: null,
	armedAt: null,
};

const defaultFile = () => path.join(markersDir(hostRoot()), TRIPWIRE_FILE);

/** The commands a session re-arms by. */
const rearmCommands = () => {
	const cli = `node ${scriptPath("peak-tripwire.js")}`;
	return { status: `${cli} status`, arm: `${cli} arm` };
};

/**
 * The persisted state; `corrupt` says why a file that is there would not
 * read.
 * @param {{ file?: string }} [o]
 * @returns {Read}
 */
function readTripwire({ file } = {}) {
	try {
		const text = readText(file ?? defaultFile());
		if (text.state === "absent")
			return { tripwire: { ...ARMED }, corrupt: null };
		if (text.state === "unreadable") throw text.error;
		const parsed = JSON.parse(text.data);
		if (
			!(parsed instanceof Object) ||
			(parsed.state !== "armed" && parsed.state !== "tripped")
		)
			throw new Error("no armed or tripped state");
		return { tripwire: { ...ARMED, ...parsed }, corrupt: null };
	} catch (e) {
		return {
			tripwire: { ...ARMED },
			corrupt: `${TRIPWIRE_FILE} unreadable: ${caught(e).message}`,
		};
	}
}

/** @param {string} file @param {Tripwire} t */
const writeTripwire = (file, t) =>
	writeFileAtomic(file, `${JSON.stringify(t, null, "\t")}\n`, { mkdir: true });

/**
 * The peak-charged runs live at `atMs`.
 * @param {ReturnType<RunReader>["runs"]} runs
 * @param {number} atMs
 * @returns {LiveRun[]}
 */
const liveAt = (runs, atMs) =>
	runs
		.filter((r) => {
			if (r.mode !== "peak") return false;
			const until = heldUntil(r, r.pids.wrapper)?.until;
			return (
				until !== undefined &&
				toSecond(Date.parse(r.at)) <= atMs &&
				atMs <= until
			);
		})
		.map(({ at, session, kind, fileCount, repo }) => ({
			at,
			session,
			kind,
			fileCount,
			repo,
		}));

/**
 * The journal since `since` read for a tripping kill.
 * @param {number} since
 * @param {{ readIncidents: IncidentReader, readRunFiles: RunReader }} ports
 * @returns {{ why: string } | { trip: Trip, liveRuns: LiveRun[] } | null}
 */
function findTrip(since, { readIncidents, readRunFiles }) {
	const read = readIncidents(since);
	if (read.why !== null) return { why: read.why };
	const testKills = read.incidents
		.flatMap((i) => i.kills)
		.filter(
			(k) =>
				k.kind === "test run" &&
				k.testRun !== null &&
				Date.parse(k.at) >= toSecond(since),
		)
		.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
	if (testKills.length === 0) return null;
	const store = readRunFiles();
	if (store.why !== null) return { why: store.why };
	for (const k of testKills) {
		const liveRuns = liveAt(store.runs, Date.parse(k.at));
		if (liveRuns.length > 0 && k.testRun !== null)
			return {
				trip: {
					at: k.at,
					pid: k.pid,
					name: k.name,
					rssMiB: k.rssMiB,
					testRun: k.testRun,
				},
				liveRuns,
			};
	}
	return null;
}

/**
 * The state after a check at `now`, from `read`, the state as last read.
 * @param {Tripwire} read
 * @param {number} now
 * @param {ReturnType<typeof findTrip>} found
 * @returns {Tripwire}
 */
function afterCheck(read, now, found) {
	const at = new Date(now).toISOString();
	if (found !== null && "why" in found)
		return { ...read, checkedAt: at, unread: { at, why: found.why } };
	const checked = { ...read, checkedAt: at, checkedThrough: at, unread: null };
	if (found === null || read.state === "tripped") return checked;
	return {
		...checked,
		state: "tripped",
		trip: found.trip,
		liveRuns: found.liveRuns,
		trippedAt: at,
	};
}

/**
 * Runs the journal check where CHECK_MS has passed since the last, persisting
 * what it finds; returns the state the gate reads.
 * @param {{ now?: number, file?: string, readIncidents?: IncidentReader,
 *   readRunFiles?: RunReader, log?: Log }} [o]
 * @returns {Read & { checked: boolean }}
 */
function checkTripwire({
	now = Date.now(),
	file,
	/* Lazy: most gate calls make no check. */
	readIncidents = (since) =>
		require("./earlyoom-kills.js").readIncidents(since),
	readRunFiles = () => require("./run-memory.js").readRunFiles(),
	log = () => undefined,
} = {}) {
	try {
		const target = file ?? defaultFile();
		const read = readTripwire({ file: target });
		const last = read.tripwire.checkedAt;
		if (
			read.corrupt !== null ||
			(last !== null && now - Date.parse(last) < CHECK_MS)
		)
			return { ...read, checked: false };
		const since =
			Date.parse(read.tripwire.checkedThrough ?? "") || now - CHECK_MS;
		const found = findTrip(since, { readIncidents, readRunFiles });
		/* Re-read: another process may have tripped or re-armed it meanwhile. */
		const latest = readTripwire({ file: target });
		if (latest.corrupt !== null) return { ...latest, checked: true };
		if (latest.tripwire.armedAt !== read.tripwire.armedAt)
			return { ...latest, checked: false };
		const next = afterCheck(latest.tripwire, now, found);
		writeTripwire(target, next);
		if (next.state === "tripped" && latest.tripwire.state === "armed")
			log(
				"peak tripwire tripped: part-suites back on the ladder",
				describeTrip(next),
			);
		if (next.unread !== null)
			log(
				"earlyoom journal unread: part-suites judged on the ladder",
				next.unread.why,
			);
		return { tripwire: next, corrupt: null, checked: true };
	} catch (e) {
		const why = `peak tripwire check failed: ${caught(e).message}`;
		log(why);
		return { tripwire: { ...ARMED }, corrupt: why, checked: false };
	}
}

/**
 * The tripping kill and how many peak-charged runs were live at it, one line.
 * @param {Tripwire} t
 */
function describeTrip(t) {
	if (t.trip === null) return "no tripping kill recorded";
	const { trip } = t;
	const run = trip.testRun;
	return `earlyoom killed pid ${trip.pid} (${trip.name}, VmRSS ${trip.rssMiB} MiB) at ${trip.at}, the ${run.role} of a ${run.kind} run in ${run.repo}, while ${t.liveRuns.length} peak-charged ${t.liveRuns.length === 1 ? "run was" : "runs were"} live`;
}

/**
 * The gate's reading: null where part-suites may take the peak charge, else
 * why they fall back to the ladder. Runs the throttled check.
 * @param {Parameters<typeof checkTripwire>[0]} [o]
 * @returns {Fallback|null}
 */
function gateTripwire(o = {}) {
	const { tripwire, corrupt } = checkTripwire(o);
	if (corrupt !== null) return { cause: "state-unread", why: corrupt };
	if (tripwire.state === "tripped")
		return { cause: "tripped", why: describeTrip(tripwire) };
	if (tripwire.unread !== null)
		return { cause: "journal-unread", why: tripwire.unread.why };
	return null;
}

/**
 * Re-arm, the cursor advanced to `now`, so a kill before this second cannot
 * trip it again. Throws where the file will not write.
 * @param {{ session: string, now?: number, file?: string }} o
 * @returns {Tripwire}
 */
function armTripwire({ session, now = Date.now(), file }) {
	const target = file ?? defaultFile();
	const { tripwire } = readTripwire({ file: target });
	const at = new Date(now).toISOString();
	/** @type {Tripwire} */
	const next = {
		...tripwire,
		state: "armed",
		trip: null,
		liveRuns: [],
		trippedAt: null,
		checkedThrough: at,
		armedBy: session,
		armedAt: at,
	};
	writeTripwire(target, next);
	return next;
}

module.exports = {
	armTripwire,
	describeTrip,
	gateTripwire,
	readTripwire,
	rearmCommands,
};
