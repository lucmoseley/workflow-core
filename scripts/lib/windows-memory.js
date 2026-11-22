const os = require("node:os");
const path = require("node:path");
const { readTail } = require("./file-read.js");
const { parseJsonl } = require("./jsonl.js");

// #5034 measured 7.8% of 205 minutes at 750-1,000 MB paged heavily within 5 minutes
const WINDOWS_FLOOR_MB = 750;
// #4852 measured 46% of 52 minutes at the line followed by another, 2.4% under it
const WINDOWS_PAGING_LINE = 100_000;

// #4557 guess
const WINDOWS_FRESH_S = 180;

const TAIL_BYTES = 16 * 1024;

/** @returns {string} */
function minuteLogPath() {
	return (
		process.env.MEMWATCH_MINUTE_LOG ||
		path.join(os.homedir(), "memwatch-minute.jsonl")
	);
}

/**
 * @typedef {{ state: "fresh", mb: number, ageS: number, pagesIn?: number }} WindowsMinute
 * @typedef {WindowsMinute
 *   | { state: "absent" }
 *   | { state: "stale", why: string }} WindowsRead
 */

/**
 * @param {Record<string, unknown>} row
 * @returns {WindowsMinute | null}
 */
function windowsReadingOf(row) {
	if (
		typeof row.ts !== "string" ||
		typeof row.win_avail_mb !== "number" ||
		typeof row.win_age_s !== "number"
	)
		return null;
	return {
		state: "fresh",
		mb: row.win_avail_mb,
		ageS: row.win_age_s,
		...(typeof row.win_pages_in === "number"
			? { pagesIn: row.win_pages_in }
			: {}),
	};
}

/** @param {{ ageS: number }} reading */
const isWindowsFresh = (reading) => reading.ageS <= WINDOWS_FRESH_S;

/**
 * @param {string} tail
 * @returns {{ ts: string, reading: WindowsMinute } | null}
 */
function newestReading(tail) {
	for (const row of parseJsonl(tail).rows.toReversed()) {
		const reading = windowsReadingOf(row);
		if (reading) return { ts: String(row.ts), reading };
	}
	return null;
}

/**
 * @param {{ file?: string, now?: number }} [options]
 * @returns {WindowsRead}
 */
function readWindowsMemory({ file = minuteLogPath(), now = Date.now() } = {}) {
	const tail = readTail(file, TAIL_BYTES);
	if (tail.state === "absent") return { state: "absent" };
	if (tail.state === "unreadable")
		return { state: "stale", why: `${file} unreadable: ${tail.message}` };
	const newest = newestReading(tail.data.text);
	if (newest === null)
		return {
			state: "stale",
			why: `no Windows reading in ${file}'s last lines`,
		};
	const lineMs = Date.parse(newest.ts);
	if (Number.isNaN(lineMs))
		return { state: "stale", why: `${file} line stamped ${newest.ts}` };
	const ageS = Math.round((now - lineMs) / 1000) + newest.reading.ageS;
	const aged = { ...newest.reading, ageS };
	if (!isWindowsFresh(aged))
		return {
			state: "stale",
			why: `the newest Windows reading in ${file} is ${ageS} s old, past ${WINDOWS_FRESH_S} s`,
		};
	return aged;
}

/**
 * @param {WindowsRead} read
 * @returns {WindowsHold | null}
 */
function windowsShortfall(read) {
	if (read.state !== "fresh") return null;
	const paging =
		read.pagesIn !== undefined && read.pagesIn >= WINDOWS_PAGING_LINE;
	if (read.mb >= WINDOWS_FLOOR_MB && !paging) return null;
	return { mb: read.mb, ...(paging ? { pagesIn: read.pagesIn } : {}) };
}

/**
 * @typedef {{ mb: number, pagesIn?: number }} WindowsHold
 */

/**
 * @param {WindowsRead} read
 * @param {number | null} guestFreeMb
 */
function windowsUnbackedMb(read, guestFreeMb) {
	if (read.state !== "fresh" || guestFreeMb === null) return 0;
	const roomMb = Math.max(0, read.mb - WINDOWS_FLOOR_MB);
	return Math.max(0, guestFreeMb - roomMb);
}

/**
 * @param {WindowsRead} read
 * @param {string} what
 */
const buildWindowsUnreadNote = (read, what) =>
	read.state === "stale"
		? `Windows memory unread — ${read.why}; ${what} not held on it (#4557)`
		: null;

/**
 * @param {() => WindowsRead} readWindows
 * @param {(what: string) => void} log
 * @param {string} what
 * @returns {WindowsRead}
 */
function readWindowsRecorded(readWindows, log, what) {
	const read = readWindows();
	const note = buildWindowsUnreadNote(read, what);
	if (note) log(note);
	return read;
}

/**
 * @param {WindowsHold} short
 */
const describeWindowsHold = (short) =>
	short.pagesIn === undefined
		? `Windows itself has ${short.mb} MB free (memwatch's win_avail_mb), under its ${WINDOWS_FLOOR_MB} MB floor`
		: `Windows is paging ${short.pagesIn} pages a minute in from disk, at or over its ${WINDOWS_PAGING_LINE} line, with ${short.mb} MB free`;

/**
 * @param {WindowsHold} short
 */
const buildWindowsShortText = (short) =>
	`${describeWindowsHold(short)}; a launch now would deepen Windows' paging, which has frozen the VM (#4557, #4850)`;

module.exports = {
	WINDOWS_FLOOR_MB,
	buildWindowsShortText,
	describeWindowsHold,
	buildWindowsUnreadNote,
	isWindowsFresh,
	minuteLogPath,
	readWindowsMemory,
	readWindowsRecorded,
	windowsReadingOf,
	windowsShortfall,
	windowsUnbackedMb,
};
