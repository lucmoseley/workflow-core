const fs = require("node:fs");
const path = require("node:path");
const { readProcStartOf, pidAlive } = require("./arbiter-proc.js");
const { storeConfigDir } = require("./arbiter-core.js");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught } = require("./caught.js");
const { readJsonl } = require("./jsonl.js");
const { pidLock } = require("./pid-lock.js");
const { readText } = require("./file-read.js");
const { writeFd } = require("./write-fd.js");

// #5376
const HOLD_MS = 2 * 60 * 60 * 1000;
// guess, #5368
const GIVE_UP_ATTEMPTS = 3;
const GIVE_UP_MS = 7 * 24 * 60 * 60 * 1000;
const NOT_CONNECTED_BACKOFF_MS = 60 * 60 * 1000;
// guess, #5392
const FAILED_BACKOFF_MS = 6 * 60 * 60 * 1000;

/**
 * @typedef {{tabId: number, title: string, url: string}} HeldTab
 * @typedef {{
 *   sessionId: string, seat: string,
 *   launcherPid: number, launcherStart: string | null,
 *   childPid: number | null, childStart: string | null,
 *   startedAt: string, attempts: number, lastAttemptAt?: string,
 *   lastReason?: string, tabs?: HeldTab[],
 *   heldSince?: string, heldTab?: HeldTab,
 * }} ChildRecord
 * @typedef {ChildRecord & {givenUpAt: string, reason: string}} GivenUpRecord
 * @typedef {{sessionId: string, heldSince?: string, closedAt: string,
 *   by: "trap" | "done" | "sweep"}} ClosedLine
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const storeDir = () => path.join(storeConfigDir(), "chrome-children");
const givenUpDir = () => path.join(storeDir(), "given-up");
const closedLog = () => path.join(storeDir(), "closed.jsonl");
const firstLaunchFile = () => path.join(storeDir(), "first-launch");
const lastSweepFile = () => path.join(storeDir(), "last-sweep");
const makeDir = (dir = storeDir()) =>
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
/** @param {string} id */
const recordFile = (id) => path.join(storeDir(), `${id}.json`);

/** @param {string} id */
function assertId(id) {
	if (!UUID.test(id)) throw new Error(`'${id}' is not a session id.`);
}

/**
 * @param {string} file
 * @returns {unknown}
 */
function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (e) {
		if (caught(e).code === "ENOENT") return null;
		if (e instanceof SyntaxError) {
			writeFd(
				2,
				`chrome-child-store: ${file} is not JSON, so no closer reads it (${e.message}).\n`,
			);
			return null;
		}
		throw e;
	}
}

/** @param {ChildRecord} record */
function writeRecord(record) {
	assertId(record.sessionId);
	makeDir();
	if (!fs.existsSync(firstLaunchFile()))
		writeFileAtomic(firstLaunchFile(), `${record.startedAt}\n`);
	writeFileAtomic(
		recordFile(record.sessionId),
		`${JSON.stringify(record, null, "\t")}\n`,
	);
}

/**
 * @param {string} id
 * @returns {ChildRecord | null}
 */
function readRecord(id) {
	assertId(id);
	return /** @type {ChildRecord | null} */ (readJson(recordFile(id)));
}

/** @param {string} file */
function readStamp(file) {
	const read = readText(file);
	if (read.state === "absent") return null;
	if (read.state === "unreadable") throw read.error;
	const text = read.data.trim();
	return Number.isNaN(Date.parse(text)) ? null : text;
}

function readFirstLaunch() {
	const stamp = readStamp(firstLaunchFile());
	return stamp === null ? null : Date.parse(stamp);
}

const readLastSweep = () => readStamp(lastSweepFile());

/** @param {Date} at */
function writeLastSweep(at) {
	makeDir();
	writeFileAtomic(lastSweepFile(), `${at.toISOString()}\n`);
}

/** @param {string} id */
function deleteRecord(id) {
	assertId(id);
	fs.rmSync(recordFile(id), { force: true });
}

/**
 * @param {string} dir
 * @returns {unknown[]}
 */
function readRecordsIn(dir) {
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch (e) {
		if (caught(e).code === "ENOENT") return [];
		throw e;
	}
	return names
		.filter((n) => UUID.test(n.replace(/\.json$/, "")) && n.endsWith(".json"))
		.sort()
		.map((n) => readJson(path.join(dir, n)))
		.filter((r) => r !== null);
}

/** @returns {ChildRecord[]} */
const listRecords = () =>
	/** @type {ChildRecord[]} */ (readRecordsIn(storeDir()));

/** @returns {GivenUpRecord[]} */
const listGivenUp = () =>
	/** @type {GivenUpRecord[]} */ (readRecordsIn(givenUpDir()));

/**
 * @param {ChildRecord} record
 * @param {string} reason
 * @param {Date} at
 * @returns {GivenUpRecord}
 */
function giveUp(record, reason, at) {
	const gone = { ...record, givenUpAt: at.toISOString(), reason };
	makeDir(givenUpDir());
	writeFileAtomic(
		path.join(givenUpDir(), `${record.sessionId}.json`),
		`${JSON.stringify(gone, null, "\t")}\n`,
	);
	deleteRecord(record.sessionId);
	return gone;
}

/** @param {ClosedLine} line */
function appendClosed(line) {
	makeDir();
	fs.appendFileSync(closedLog(), `${JSON.stringify(line)}\n`);
}

/** @returns {ClosedLine[]} */
function readClosedLog() {
	return /** @type {ClosedLine[]} */ (
		/** @type {unknown} */ (readJsonl(closedLog())?.rows ?? [])
	);
}

/** @param {string} id */
function recordLock(id) {
	assertId(id);
	makeDir();
	return pidLock(path.join(storeDir(), `${id}.lock`), "claude-child.js");
}

/**
 * @param {number | null} pid
 * @param {string | null} start
 */
function isProcessLive(pid, start) {
	if (!pid || !start || !pidAlive(pid)) return false;
	return readProcStartOf(pid) === start;
}

/** @param {ChildRecord} record */
function clockStart(record) {
	return record.heldSince
		? Date.parse(record.heldSince) + HOLD_MS
		: Date.parse(record.startedAt);
}

/**
 * @param {ChildRecord} record
 * @param {number} now
 * @param {{launcherLive: boolean, locked: boolean}} state
 * @returns {string | null}
 */
function sweepSkip(record, now, { launcherLive, locked }) {
	if (launcherLive) return "its launcher still runs";
	if (locked) return "another closer holds it";
	if (record.heldSince && now < Date.parse(record.heldSince) + HOLD_MS)
		return "it is held for the founder";
	const last = record.lastAttemptAt
		? Date.parse(record.lastAttemptAt)
		: Number.NaN;
	if (record.lastReason === "not-connected") {
		if (now < last + NOT_CONNECTED_BACKOFF_MS)
			return "its bridge was not connected within the hour";
	} else if (now < last + FAILED_BACKOFF_MS)
		return `its last resume failed within ${FAILED_BACKOFF_MS / 3_600_000} h`;
	return null;
}

/**
 * @param {ChildRecord} record
 * @param {number} now
 */
const isSpent = (record, now) =>
	record.attempts >= GIVE_UP_ATTEMPTS || now - clockStart(record) >= GIVE_UP_MS;

module.exports = {
	GIVE_UP_MS,
	HOLD_MS,
	UUID,
	appendClosed,
	deleteRecord,
	giveUp,
	isSpent,
	listGivenUp,
	listRecords,
	isProcessLive,
	readClosedLog,
	readFirstLaunch,
	readLastSweep,
	readRecord,
	recordLock,
	sweepSkip,
	writeLastSweep,
	writeRecord,
};
