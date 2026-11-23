const fs = require("node:fs");
const { writeFileAtomic } = require("./atomic-write.js");
const { orFallback } = require("./caught.js");

/**
 * @typedef {{from: number, to: number, frozen: number}} Wake
 * @typedef {{floor: number, wakes: Wake[]}} MachineClock
 * @typedef {{startedAt: number, now: number, bootId: string|null}} ClockReading
 * @typedef {{startedAt: number, at: number, bootId: string|null,
 *   floor: number, wakes: Wake[]}} WakeMarker
 */

const WAKE = ".machine-wake.json";
// guess, #4055
const WAKE_SLACK_MS = 5 * 60 * 1000;
// guess, #5612
const MAX_WAKES = 64;

/**
 * @param {MachineClock} clock
 * @param {number} since
 * @param {number} now
 */
function upSince(clock, since, now) {
	const start = Math.max(since, clock.floor);
	const frozen = clock.wakes.reduce(
		(sum, w) =>
			w.to <= start
				? sum
				: sum + (w.from >= start ? w.frozen : Math.min(w.frozen, w.to - start)),
		0,
	);
	return { ms: Math.max(0, now - start - frozen), frozen };
}

/** @param {unknown} w */
const isWake = (w) =>
	typeof w === "object" &&
	w !== null &&
	["from", "to", "frozen"].every(
		(k) => typeof (/** @type {Record<string, unknown>} */ (w)[k]) === "number",
	);

/**
 * @param {Record<string, unknown>|null} rec
 * @returns {rec is WakeMarker}
 */
const isMarker = (rec) =>
	typeof rec?.startedAt === "number" &&
	typeof rec.at === "number" &&
	typeof rec.floor === "number" &&
	(typeof rec.bootId === "string" || rec.bootId === null) &&
	Array.isArray(rec.wakes) &&
	rec.wakes.every(isWake);

/**
 * @param {number} last
 * @param {ClockReading} r
 */
const hasRisen = (last, r) => r.startedAt - last > WAKE_SLACK_MS;

/**
 * @param {ClockReading} r
 * @param {number} floor
 * @returns {WakeMarker}
 */
const buildFreshMarker = (r, floor) => ({
	startedAt: r.startedAt,
	at: r.now,
	bootId: r.bootId,
	floor,
	wakes: [],
});

/**
 * @param {WakeMarker} rec
 * @param {ClockReading} r
 * @returns {WakeMarker}
 */
function buildNextMarker(rec, r) {
	if (rec.bootId !== null && r.bootId !== null && rec.bootId !== r.bootId)
		return buildFreshMarker(r, r.startedAt);
	if (!hasRisen(rec.startedAt, r)) return { ...rec, at: r.now };
	if ((rec.bootId === null || r.bootId === null) && r.startedAt >= rec.at)
		return buildFreshMarker(r, r.now);
	const wakes = [
		...rec.wakes,
		{ from: rec.at, to: r.now, frozen: r.startedAt - rec.startedAt },
	];
	const dropped = wakes.splice(0, Math.max(0, wakes.length - MAX_WAKES));
	return {
		...buildFreshMarker(r, Math.max(rec.floor, ...dropped.map((w) => w.to))),
		wakes,
	};
}

/**
 * @param {Record<string, unknown>|null} rec
 * @param {ClockReading} r
 * @returns {WakeMarker}
 */
function buildFirstMarker(rec, r) {
	if (rec === null) return buildFreshMarker(r, r.startedAt);
	const last = rec.startedAt;
	if (typeof last !== "number" || hasRisen(last, r))
		return buildFreshMarker(r, r.now);
	const floor = typeof rec.wokeAt === "number" ? rec.wokeAt : r.now;
	return { ...buildFreshMarker(r, floor), startedAt: last };
}

/**
 * @param {string} file
 * @param {ClockReading} r
 * @returns {MachineClock}
 */
function recordWake(file, r) {
	/** @type {Record<string, unknown>|null} */
	const rec = orFallback(() => JSON.parse(fs.readFileSync(file, "utf8")), null);
	const known = isMarker(rec);
	const next = known ? buildNextMarker(rec, r) : buildFirstMarker(rec, r);
	const clock = { floor: next.floor, wakes: next.wakes };
	try {
		writeFileAtomic(file, `${JSON.stringify(next)}\n`, { mkdir: true });
	} catch {
		return known ? clock : { floor: r.startedAt, wakes: [] };
	}
	return clock;
}

module.exports = { WAKE, recordWake, upSince };
