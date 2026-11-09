/*
 * windows-memory.js — the Windows-memory hold (#4557): Windows' own free
 * memory, off memwatch's newest `win_avail_mb` reading, and whether a launch
 * fits in it. One definition for the suite gate, the type-check slot and
 * session admission, beside their guest rungs.
 *
 * WHY A GUEST RUNG CANNOT SEE IT. The guest takes new pages from its own
 * unbacked free memory before it evicts page cache, growing `vmmemWSL` on
 * Windows, so a guest reading 8 GB available can still draw more than Windows
 * has. On 6 Nov 2026 a test run froze the VM with the guest never short and
 * Windows paging 172k pages a minute (docs/environment.md §7).
 *
 * IT READS memwatch's FILE, NEVER WINDOWS: a `powershell.exe` call costs host
 * CPU and seconds, and a freeze has begun during one (#4557). memwatch reads
 * Windows in the background each minute (docs/environment.md §4).
 *
 * FAILS OPEN where no fresh reading exists. A machine with no minute log runs
 * no memwatch, as an adopter's need not, and is silent; a log with no fresh
 * reading is named, for the caller to record.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { caught } = require("./caught.js");
const { parseJsonl } = require("./jsonl.js");
const { DRAW_MARGIN_MB } = require("./suite-ladder.js");

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
 * @typedef {{ state: "fresh", mb: number, ageS: number }
 *   | { state: "absent" }
 *   | { state: "stale", why: string }} WindowsRead
 */

/**
 * The last TAIL_BYTES of `file`, null where it does not exist. Its own read,
 * not file-read.js's: that reads a whole file, and the log runs to tens of MB.
 * @param {string} file
 * @returns {string | null}
 */
function readTail(file) {
	let fd;
	try {
		fd = fs.openSync(file, "r");
	} catch (e) {
		if (caught(e).code === "ENOENT") return null;
		throw e;
	}
	try {
		const size = fs.fstatSync(fd).size;
		const length = Math.min(size, TAIL_BYTES);
		const buf = Buffer.alloc(length);
		fs.readSync(fd, buf, 0, length, size - length);
		return buf.toString("utf8");
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * The newest row in `tail` carrying a Windows reading, null where none does.
 * The tail's cut first line and a torn last one parse to no row.
 * @param {string} tail
 * @returns {{ ts: string, mb: number, winAgeS: number } | null}
 */
function newestReading(tail) {
	const r = parseJsonl(tail).rows.findLast(
		(row) =>
			typeof row.ts === "string" &&
			typeof row.win_avail_mb === "number" &&
			typeof row.win_age_s === "number",
	);
	return r
		? {
				ts: String(r.ts),
				mb: Number(r.win_avail_mb),
				winAgeS: Number(r.win_age_s),
			}
		: null;
}

/**
 * Windows' free memory as memwatch last read it, if that reading is fresh.
 * @param {{ file?: string, now?: number }} [options]
 * @returns {WindowsRead}
 */
function readWindowsMemory({ file = minuteLogPath(), now = Date.now() } = {}) {
	let tail;
	try {
		tail = readTail(file);
	} catch (e) {
		return {
			state: "stale",
			why: `${file} unreadable: ${caught(e).message}`,
		};
	}
	if (tail === null) return { state: "absent" };
	const reading = newestReading(tail);
	if (reading === null)
		return {
			state: "stale",
			why: `no Windows reading in ${file}'s last lines`,
		};
	const lineMs = Date.parse(reading.ts);
	if (Number.isNaN(lineMs))
		return { state: "stale", why: `${file} line stamped ${reading.ts}` };
	const ageS = Math.round((now - lineMs) / 1000) + reading.winAgeS;
	if (ageS > WINDOWS_FRESH_S)
		return {
			state: "stale",
			why: `the newest Windows reading in ${file} is ${ageS} s old, past ${WINDOWS_FRESH_S} s`,
		};
	return { state: "fresh", mb: reading.mb, ageS };
}

/**
 * What Windows must hold free for a launch that has `drawMb` yet to draw:
 * that draw and the guest rungs' DRAW_MARGIN_MB, but not earlyoom's line,
 * which is the guest's. What is already running holds its pages in
 * `vmmemWSL` and is not charged again.
 * @param {number} drawMb
 */
const windowsNeedMb = (drawMb) => drawMb + DRAW_MARGIN_MB;

/**
 * The hold a launch needing `needMb` of Windows meets, null where the reading
 * fits it or is not fresh.
 * @param {WindowsRead} read
 * @param {number} needMb
 * @returns {{ mb: number, needMb: number } | null}
 */
function windowsShortfall(read, needMb) {
	return read.state === "fresh" && read.mb < needMb
		? { mb: read.mb, needMb }
		: null;
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

/** Why the hold reads Windows, as every text naming it says. */
const WINDOWS_PAGING_WHY =
	"the VM grows into Windows' memory before the guest evicts its page cache";

/**
 * The hold as a deny or a wait line names it.
 * @param {{ mb: number, needMb: number }} short
 */
const buildWindowsShortText = (short) =>
	`Windows itself has ${short.mb} MB free (memwatch's win_avail_mb), under the ~${short.needMb} MB this launch draws plus the margin; ${WINDOWS_PAGING_WHY}, so a guest reading plenty can still page Windows (docs/environment.md §6, #4557)`;

module.exports = {
	WINDOWS_PAGING_WHY,
	buildWindowsShortText,
	buildWindowsUnreadNote,
	minuteLogPath,
	readWindowsMemory,
	readWindowsRecorded,
	windowsNeedMb,
	windowsShortfall,
};
