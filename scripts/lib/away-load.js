/*
 * away-load.js — what the away-only reset-precondition runner (workflow-core#5472) does
 * next. No I/O: `scripts/away-load.js` reads
 * memwatch and Windows, acts on the verdict and logs it.
 *
 * The precondition is workflow-core#5346's: a minute with WSL CPU at or over 550% of 800
 * and Windows free memory under 900 MB. The runner makes that minute only
 * while Windows has had no keyboard or mouse input for 15 minutes, holding Windows
 * free memory in a band above the Windows-memory hold's 750 MB floor
 * (lib/windows-memory.js), so the refill loop keeps admitting some sessions.
 */

/* workflow-core#5346's gate: its start, its count and the Kernel-Power 41 it counts from. */
const GATE_SINCE = "2026-11-11T17:27";
const GATE_MINUTES = 1308;
const RESET_AFTER = "2026-11-11T17:26:26";
const PRECONDITION_BUSY_PCT = 550;
const PRECONDITION_WIN_MB = 900;

/* workflow-core#5449's ruling: the away trigger and the band. Untraced, both. */
const AWAY_S = 15 * 60;
const BAND_LOW_MB = 760;
const BAND_HIGH_MB = 890;
const BAND_AIM_MB = 825;

/* To start: memwatch's own bound on a reading's age (WIN_MAX_AGE_S, 120 s).
 * While loaded: one minute's read plus 15 s for a read slowed by the load
 * and the poll (workflow-core#4159). */
const READING_MAX_AGE_S = 120;
const RUNNING_MAX_AGE_S = 75;

/* Untraced margins. A holder is one Testlimit process of HOLDER_MB, so a
 * release under the band frees about what it is short. Its pages are not
 * locked, so Windows can trim them and the runner tops up, bounded by the
 * commit line and the total. The CPU aim sits over the precondition line so a
 * minute's dip stays over it; load1 stays clear of the admission load
 * ceiling's 24 (lib/cpu-sample.js). */
const CHUNK_MB = 64;
const HOLDER_MB = 2 * CHUNK_MB;
const MAX_HELD_MB = 8000;
const MAX_COMMIT_PCT = 85;
const BUSY_LOW_PCT = 580;
const BUSY_AIM_PCT = 620;
const BUSY_HIGH_PCT = 720;
const MAX_WORKERS = 7;
const LOAD1_LINE = 20;

/**
 * @typedef {{ at: number, availMb: number, commitPct: number, idleS: number|null }} Reading
 *   memwatch's newest Windows reading: epoch seconds, free MB, commit charge
 *   as a percentage of the limit, seconds since the last input, null where
 *   that read failed.
 * @typedef {{ ts: string, busyPct: number|null, load1: number|null }} Minute
 */

/**
 * memwatch's raw reading file: epoch, free MB, pages in, pages out, commit
 * charge, commit limit, idle seconds (-1 where that read failed).
 * @param {string} text
 * @returns {Reading|null}
 */
function parseReading(text) {
	const m = /^(\d+) (\d+) \d+ \d+ (\d+) (\d+) (-1|\d+)\s*$/.exec(text);
	if (!m || Number(m[4]) === 0) return null;
	return {
		at: Number(m[1]),
		availMb: Number(m[2]),
		commitPct: Math.floor((Number(m[3]) * 100) / Number(m[4])),
		idleS: m[5] === "-1" ? null : Number(m[5]),
	};
}

/** @param {Record<string, unknown>} row @returns {Minute|null} */
function minuteOf(row) {
	if (typeof row.ts !== "string") return null;
	const num = (/** @type {unknown} */ v) => (typeof v === "number" ? v : null);
	return { ts: row.ts, busyPct: num(row.cpu_busy_pct), load1: num(row.load1) };
}

/**
 * Whether a minute line counts toward workflow-core#5346's gate, as its check's `or` reads
 * it: a 0 as missing.
 * @param {Record<string, unknown>} row
 */
function isPreconditionMinute(row) {
	const busy = Number(row.cpu_busy_pct) || 0;
	const win = Number(row.win_avail_mb) || 9e9;
	return (
		typeof row.ts === "string" &&
		row.ts.slice(0, 16) >= GATE_SINCE &&
		busy >= PRECONDITION_BUSY_PCT &&
		win < PRECONDITION_WIN_MB
	);
}

/**
 * The newest Kernel-Power 41's `Date:` from `wevtutil qe … /f:text`, compared
 * as workflow-core#5346's own check compares it.
 * @param {string} text
 * @returns {string|null} `YYYY-MM-DDTHH:MM:SS`
 */
function newestResetOf(text) {
	const m = /^[ \t]*Date: (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)/m.exec(text);
	return m?.[1] ?? null;
}

/** @param {string|null} reset */
const isGateReset = (reset) => reset !== null && reset > RESET_AFTER;

/**
 * @typedef {{ kind: "none" }
 *   | { kind: "start", why: string }
 *   | { kind: "stop", why: string }
 *   | { kind: "finish", why: string }} Verdict
 */

/**
 * @param {{ now: number, running: boolean, reading: Reading|null,
 *   handUntil: number|null, gateCount: number, done: string|null }} s
 *   `now` and `handUntil` in epoch seconds; a hand start runs until then
 *   whatever the input.
 * @returns {Verdict}
 */
function decide(s) {
	if (s.done !== null)
		return s.running ? { kind: "stop", why: s.done } : { kind: "none" };
	if (s.gateCount >= GATE_MINUTES)
		return {
			kind: "finish",
			why: `the page-combining gate met (clean): ${s.gateCount} of ${GATE_MINUTES} precondition minutes (workflow-core#5346)`,
		};
	if (s.handUntil !== null && s.now < s.handUntil)
		return s.running ? { kind: "none" } : { kind: "start", why: "hand start" };
	const ageS = s.reading === null ? null : s.now - s.reading.at;
	return s.running
		? whileRunning(s.reading, ageS)
		: whileWaiting(s.reading, ageS);
}

/** @param {Reading|null} r @param {number|null} ageS @returns {Verdict} */
function whileWaiting(r, ageS) {
	return r?.idleS != null &&
		ageS !== null &&
		ageS <= READING_MAX_AGE_S &&
		r.idleS >= AWAY_S
		? { kind: "start", why: `no Windows input for ${r.idleS} s` }
		: { kind: "none" };
}

/** @param {Reading|null} r @param {number|null} ageS @returns {Verdict} */
function whileRunning(r, ageS) {
	if (!r || ageS === null || ageS > RUNNING_MAX_AGE_S)
		return {
			kind: "stop",
			why: `no Windows reading under ${RUNNING_MAX_AGE_S} s old`,
		};
	if (r.idleS === null)
		return { kind: "stop", why: "Windows' input time would not read" };
	if (r.idleS < AWAY_S)
		return {
			kind: "stop",
			why: `Windows input ${r.idleS} s before the reading`,
		};
	return { kind: "none" };
}

/** @param {{ mb: number }[]} holders */
const heldMb = (holders) => holders.reduce((sum, h) => sum + h.mb, 0);

/**
 * The memory hold's step on a new reading: holders to add, of HOLDER_MB at
 * most, newest holders to drop until about the shortfall is freed, or nothing.
 * @template {{ mb: number }} H
 * @param {Reading} reading
 * @param {H[]} holders oldest first
 * @returns {{ add: number[] } | { drop: H[] } | null}
 */
function holdStep(reading, holders) {
	if (reading.availMb < BAND_LOW_MB) {
		const drop = [];
		let freed = 0;
		for (const h of [...holders].reverse()) {
			if (freed >= BAND_AIM_MB - reading.availMb) break;
			drop.push(h);
			freed += h.mb;
		}
		return drop.length > 0 ? { drop } : null;
	}
	if (reading.availMb <= BAND_HIGH_MB || reading.commitPct >= MAX_COMMIT_PCT)
		return null;
	const want = Math.ceil((reading.availMb - BAND_AIM_MB) / CHUNK_MB) * CHUNK_MB;
	const room =
		Math.floor((MAX_HELD_MB - heldMb(holders)) / CHUNK_MB) * CHUNK_MB;
	let left = Math.min(want, room);
	const add = [];
	while (left > 0) {
		add.push(Math.min(HOLDER_MB, left));
		left -= HOLDER_MB;
	}
	return add.length > 0 ? { add } : null;
}

/**
 * How many CPU workers to run after a new minute line.
 * @param {Minute} minute
 * @param {number} workers running now
 */
function workersFor(minute, workers) {
	if (minute.load1 !== null && minute.load1 >= LOAD1_LINE)
		return Math.max(0, workers - 1);
	if (minute.busyPct === null) return workers;
	if (minute.busyPct < BUSY_LOW_PCT)
		return Math.min(
			MAX_WORKERS,
			workers + Math.ceil((BUSY_AIM_PCT - minute.busyPct) / 100),
		);
	if (minute.busyPct > BUSY_HIGH_PCT) return Math.max(0, workers - 1);
	return workers;
}

module.exports = {
	CHUNK_MB,
	GATE_MINUTES,
	decide,
	heldMb,
	holdStep,
	isGateReset,
	isPreconditionMinute,
	minuteOf,
	newestResetOf,
	parseReading,
	workersFor,
};
