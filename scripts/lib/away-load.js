const PRECONDITION_BUSY_PCT = 550;
const PRECONDITION_WIN_MB = 900;

// guess, workflow-core#5449
const AWAY_S = 15 * 60;
const BAND_LOW_MB = 760;
const BAND_HIGH_MB = 890;
const BAND_AIM_MB = 825;

// guess, workflow-core#4159
const READING_MAX_AGE_S = 120;
const RUNNING_MAX_AGE_S = 75;

// guess, workflow-core#5529
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
 * @typedef {{ ts: string, busyPct: number|null, load1: number|null }} Minute
 * @typedef {{ ticket: number, since: string, minutes: number, resetAfter: string }} Gate
 */

/**
 * @param {string} text
 * @returns {Gate|null}
 */
function parseGate(text) {
	let g;
	try {
		g = JSON.parse(text);
	} catch {
		return null;
	}
	const isWhole = (/** @type {unknown} */ v) =>
		typeof v === "number" && Number.isInteger(v) && v > 0;
	return g !== null &&
		isWhole(g.ticket) &&
		isWhole(g.minutes) &&
		typeof g.since === "string" &&
		/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(g.since) &&
		typeof g.resetAfter === "string"
		? {
				ticket: g.ticket,
				since: g.since,
				minutes: g.minutes,
				resetAfter: g.resetAfter,
			}
		: null;
}

/** @param {Date} at @returns {string} */
function nextLocalMinute(at) {
	const d = new Date(at.getTime() + 60_000);
	const two = (/** @type {number} */ n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
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

/** @param {Record<string, unknown>} row @param {Gate} gate */
function isPreconditionMinute(row, gate) {
	const busy = Number(row.cpu_busy_pct) || 0;
	const win = Number(row.win_avail_mb) || 9e9;
	return (
		typeof row.ts === "string" &&
		row.ts.slice(0, 16) >= gate.since &&
		busy >= PRECONDITION_BUSY_PCT &&
		win < PRECONDITION_WIN_MB
	);
}

/**
 * @param {string} text
 * @returns {string|null}
 */
function newestResetOf(text) {
	const m = /^[ \t]*Date: (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)/m.exec(text);
	return m?.[1] ?? null;
}

/** @param {string|null} reset @param {Gate} gate */
const isGateReset = (reset, gate) => reset !== null && reset > gate.resetAfter;

/**
 * @param {Gate} gate
 * @param {number} count
 * @param {string|null} reset
 */
function gateReading(gate, count, reset) {
	let state = count >= gate.minutes ? "met (clean)" : "unmet";
	if (isGateReset(reset, gate)) state = "met (reset)";
	return `${state}: ${count} of ${gate.minutes} precondition minutes since ${gate.since.replace("T", " ")} (#${gate.ticket}); newest Kernel-Power 41 at ${reset ?? "none"} (local time)`;
}

/**
 * @typedef {{ kind: "none" }
 *   | { kind: "start", why: string }
 *   | { kind: "stop", why: string }
 *   | { kind: "finish", why: string }} Verdict
 */

/**
 * @param {{ now: number, running: boolean, reading: Reading|null,
 *   handUntil: number|null, gate: Gate|null, gateCount: number,
 *   done: string|null }} s
 * @returns {Verdict}
 */
function decide(s) {
	if (s.done !== null)
		return s.running ? { kind: "stop", why: s.done } : { kind: "none" };
	if (s.gate !== null && s.gateCount >= s.gate.minutes)
		return {
			kind: "finish",
			why: `the gate met (clean): ${s.gateCount} of ${s.gate.minutes} precondition minutes (#${s.gate.ticket})`,
		};
	if (s.handUntil !== null && s.now < s.handUntil)
		return s.running ? { kind: "none" } : { kind: "start", why: "hand start" };
	if (s.gate === null)
		return s.running
			? { kind: "stop", why: "no gate armed" }
			: { kind: "none" };
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
 * @template {{ mb: number }} H
 * @param {Reading} reading
 * @param {H[]} holders
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
 * @param {Minute} minute
 * @param {number} workers
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
	decide,
	gateReading,
	heldMb,
	holdStep,
	isGateReset,
	isPreconditionMinute,
	minuteOf,
	newestResetOf,
	nextLocalMinute,
	parseGate,
	parseReading,
	workersFor,
};
