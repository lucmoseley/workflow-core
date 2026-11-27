const path = require("node:path");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught } = require("./caught.js");
const { readText } = require("./file-read.js");
const { hostRoot } = require("./host-root.js");
const { toSecond } = require("./journalctl.js");
const { markersDir } = require("./marker-root.js");
const { isCapped } = require("./part-suite-peak.js");
const { heldUntil } = require("./run-memory.js");
const { scriptPath } = require("./script-path.js");

const TRIPWIRE_FILE = "peak-tripwire.json";
// guess, #5366
const CHECK_MS = 30 * 1000;

/**
 * @typedef {{ at: string, pid: number, name: string, rssMiB: number,
 *   testRun: import("./earlyoom-kills.js").TestRun }} Trip
 * @typedef {{ at: string, session: string|null, kind: string,
 *   fileCount: number, repo: string }} LiveRun
 * @typedef {object} Tripwire
 * @property {"armed"|"tripped"} state
 * @property {Trip|null} trip
 * @property {LiveRun[]} liveRuns
 * @property {string|null} trippedAt
 * @property {string|null} checkedThrough
 * @property {string|null} checkedAt
 * @property {{ at: string, why: string }|null} unread
 * @property {string|null} armedBy
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

const rearmCommands = () => {
	const cli = `node ${scriptPath("peak-tripwire.js")}`;
	return { status: `${cli} status`, arm: `${cli} arm` };
};

/**
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

/** @param {ReturnType<RunReader>["runs"][number]} r */
const underCharged = (r) => r.mode === "peak" || isCapped(r.admission);

/**
 * @param {ReturnType<RunReader>["runs"]} runs
 * @param {number} atMs
 * @returns {LiveRun[]}
 */
const liveAt = (runs, atMs) =>
	runs
		.filter((r) => {
			if (!underCharged(r)) return false;
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
 * @param {number} since
 * @param {Parameters<typeof findTrip>[1]} readers
 * @returns {ReturnType<typeof findTrip>}
 */
function findTripOrWhy(since, readers) {
	try {
		return findTrip(since, readers);
	} catch (e) {
		return { why: `peak tripwire check failed: ${caught(e).message}` };
	}
}

/**
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
 * @param {{ now?: number, file?: string, readIncidents?: IncidentReader,
 *   readRunFiles?: RunReader, log?: Log }} [o]
 * @returns {Read & { checked: boolean }}
 */
function checkTripwire({
	now = Date.now(),
	file,
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
		const found = findTripOrWhy(since, { readIncidents, readRunFiles });
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

/** @param {Tripwire} t */
function describeTrip(t) {
	if (t.trip === null) return "no tripping kill recorded";
	const { trip } = t;
	const run = trip.testRun;
	return `earlyoom killed pid ${trip.pid} (${trip.name}, VmRSS ${trip.rssMiB} MiB) at ${trip.at}, the ${run.role} of a ${run.kind} run in ${run.repo}, while ${t.liveRuns.length} under-charged ${t.liveRuns.length === 1 ? "run was" : "runs were"} live`;
}

/**
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
