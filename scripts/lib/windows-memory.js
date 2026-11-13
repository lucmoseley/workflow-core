/*
 * windows-memory.js — the Windows-memory hold (#4557, #4850): Windows' own
 * free memory and paging, off memwatch's newest reading, and whether a launch
 * waits on them.
 *
 * IT HOLDS ON MEASURED RISK, NOT ON A LAUNCH'S DRAW (#4850).
 *
 * WHY A GUEST RUNG CANNOT SEE IT. The guest takes new pages from its own
 * unbacked free memory before it evicts page cache, growing `vmmemWSL` on
 * Windows (docs/environment.md §7, 6 Nov 2026).
 *
 * IT READS memwatch's FILE, NEVER WINDOWS: a `powershell.exe` call costs host
 * CPU and seconds, and a freeze has begun during one (#4557).
 *
 * FAILS OPEN where no fresh reading exists. A machine with no minute log runs
 * no memwatch and is silent; a log with no fresh reading is named, for the
 * caller to record.
 */

const os = require("node:os");
const path = require("node:path");
const { readTail } = require("./file-read.js");
const { parseJsonl } = require("./jsonl.js");

/* The free memory under which Windows holds every launch. Over #4852's day
 * and an unbroken day at this floor's load (#5034), a non-paging minute at
 * 750-1,000 MB was followed by heavy paging within 5 minutes in 7.8% of 205
 * (95% interval 4.9-12.3%), level with the 8.0% at 1,000-1,500 the floor
 * admits and under the 14.8% of 61 (8.0-25.7%) under 750, the intervals
 * overlapping. Residual: two days' reading, and they disagree on
 * same-minute paging. The band paged in 4.2% of its
 * minutes on both, within the interval of the bands above on #4852's day and
 * over it on #5034's (1.8-9.5% against 0.4-2.5% at 1,000-1,500). */
const WINDOWS_FLOOR_MB = 750;
/* The pages Windows reads in from disk since memwatch's previous reading,
 * about a minute, at and over which it holds every launch. A first guess,
 * kept over the 24 h #4852 read: a minute at it was followed by another in 46%
 * of 52, against 2.4% for one under it. */
const WINDOWS_PAGING_LINE = 100_000;

/* How old a reading may be and still hold a launch: memwatch's minute line
 * carries a reading at most 120 s old, and a line lands each 60 s, so a
 * reading past 180 s means memwatch has missed a pass. Untraced: a margin over
 * memwatch's own cadence, not a measurement. */
const WINDOWS_FRESH_S = 180;

/* The tail read: a minute line runs ~1 KB, and the newest reading is at most
 * a few lines back. */
const TAIL_BYTES = 16 * 1024;

/**
 * memwatch's minute log, as memwatch itself resolves it.
 * @returns {string}
 */
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
 * The Windows reading a memwatch minute row carries, aged by the reading's
 * own `win_age_s` alone, or null where the row carries none. The one parser
 * of the row's Windows fields, the queue-wait replay's included.
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

/**
 * Whether a reading is young enough to hold a launch.
 * @param {{ ageS: number }} reading
 */
const isWindowsFresh = (reading) => reading.ageS <= WINDOWS_FRESH_S;

/**
 * The newest row in `tail` carrying a Windows reading, with that reading,
 * null where none does. The tail's cut first line and a torn last one parse
 * to no row.
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
 * Windows' free memory as memwatch last read it, if that reading is fresh.
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
 * The hold a launch meets, null where the reading is not fresh or shows
 * Windows neither under WINDOWS_FLOOR_MB nor paging at WINDOWS_PAGING_LINE.
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
 * The guest free memory Windows cannot back above WINDOWS_FLOOR_MB (#4956):
 * the guest's free pages are not resident on Windows, so the VM grows by
 * each one a launch takes. All of it where Windows is under its floor. 0
 * where the reading is not fresh or the guest's free memory unread.
 * @param {WindowsRead} read
 * @param {number | null} guestFreeMb the guest's `MemFree`
 */
function windowsUnbackedMb(read, guestFreeMb) {
	if (read.state !== "fresh" || guestFreeMb === null) return 0;
	const roomMb = Math.max(0, read.mb - WINDOWS_FLOOR_MB);
	return Math.max(0, guestFreeMb - roomMb);
}

/**
 * The fail-open a caller records, null where there is none to record.
 * @param {WindowsRead} read
 * @param {string} what the launch the hold let through
 */
const buildWindowsUnreadNote = (read, what) =>
	read.state === "stale"
		? `Windows memory unread — ${read.why}; ${what} not held on it (#4557)`
		: null;

/**
 * A reading off `readWindows`, its fail-open written to `log`.
 * @param {() => WindowsRead} readWindows
 * @param {(what: string) => void} log
 * @param {string} what the launch the hold would let through
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
