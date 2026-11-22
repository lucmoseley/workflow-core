/*
 * overflow-notice.js — the refill loop's record of the plan seats an overflow
 * launch or a move onto a key rested on, and the lines naming them (workflow-core#3767). A
 * seat absent from the seat file is legitimate, so the overflow trigger cannot
 * refuse one: these lines are how a seat dropped by mistake is seen.
 */

const { describeAge } = require("./age-text.js");
const { buildSeatLabel, buildSeatName } = require("./refill-seats.js");

/**
 * @typedef {{seat: string, percent: number|null, weekReadAt: number|null,
 *   weekFull: boolean}} PlanSeatBasis a plan seat's weekly bar as read, whatever
 *   its trust, and 0 once its reset has passed; `weekReadAt` null where the
 *   reading has no time
 * @typedef {{at: number, seat: string, keyVar?: string,
 *   planSeats: PlanSeatBasis[], omitted: string[]}} OverflowStart `seat` and
 *   `keyVar`, the overflow seat started on, its key absent from a record
 *   written before it was kept (workflow-core#4196); `omitted`, lib/refill-seats.js's
 *   readOmittedDirs at that start
 */

/** @param {import("./refill-decide.js").SeatReading} s @returns {PlanSeatBasis} */
const planSeatBasisOf = ({ seat, weekRead, weekFull }) => ({
	seat,
	percent: weekRead.percent,
	weekReadAt: weekRead.atMs,
	weekFull,
});

/**
 * @typedef {{reason?: string, keyVar?: string, launchedAt: number,
 *   movedAt?: number}} StartedLaunch
 */

/**
 * Whether `l` runs on an overflow seat: launched on one, or moved onto its key
 * (workflow-core#3736).
 * @param {Omit<StartedLaunch, "launchedAt">} l
 */
const isOnOverflowSeat = (l) =>
	l.reason === "overflow" || l.keyVar !== undefined;

/**
 * The seat starts `l` made: its launch, and its last move where that put it on
 * a key, which only a plan seat's session is moved onto (workflow-core#4257). A resume
 * starts none.
 * @template {StartedLaunch} L
 * @param {L} l
 * @returns {{at: number, onKey: boolean, launch: L}[]}
 */
function seatStartsOf(l) {
	const onKey = isOnOverflowSeat(l);
	const launch = {
		at: l.launchedAt,
		onKey: onKey && l.movedAt === undefined,
		launch: l,
	};
	return onKey && l.movedAt !== undefined
		? [launch, { at: l.movedAt, onKey: true, launch: l }]
		: [launch];
}

/**
 * The first start on an overflow seat after `since` whose predecessor was on
 * a plan seat, or null. The first start after a record follows one on a key;
 * with no record, the first start follows a plan seat's.
 * @template {StartedLaunch} L
 * @param {L[]} launches
 * @param {number|null} since the last record's time
 * @returns {{at: number, launch: L}|null}
 */
function firstOverflowStart(launches, since) {
	let lastOnKey = since !== null;
	const starts = launches
		.flatMap(seatStartsOf)
		.filter((s) => since === null || s.at > since)
		.sort((x, y) => x.at - y.at);
	for (const s of starts) {
		if (s.onKey && !lastOnKey) return s;
		lastOnKey = s.onKey;
	}
	return null;
}

/** @param {unknown} raw */
const isPlanSeatBasis = (raw) => {
	const b = /** @type {Partial<PlanSeatBasis>|null} */ (raw);
	return typeof b?.seat === "string" && typeof b.weekFull === "boolean";
};

/**
 * Null where the record will not read; a damaged element is dropped, so it can
 * never throw at session start.
 * @param {unknown} raw
 * @returns {OverflowStart|null}
 */
function parseOverflowStart(raw) {
	const r = /** @type {Partial<OverflowStart>|null} */ (raw);
	return typeof r?.at === "number" &&
		typeof r.seat === "string" &&
		Array.isArray(r.planSeats) &&
		Array.isArray(r.omitted)
		? {
				at: r.at,
				seat: r.seat,
				...(typeof r.keyVar === "string" ? { keyVar: r.keyVar } : {}),
				planSeats: r.planSeats.filter(isPlanSeatBasis),
				omitted: r.omitted.filter((d) => typeof d === "string"),
			}
		: null;
}

/**
 * @param {PlanSeatBasis} b
 * @param {number} at the time its age is told from
 * @param {string} ageSuffix
 */
function buildPlanSeatText(
	{ seat, percent, weekReadAt, weekFull },
	at,
	ageSuffix,
) {
	const age =
		weekReadAt === null
			? "age unknown"
			: `read ${describeAge(Math.max(0, at - weekReadAt))} ${ageSuffix}`;
	const reading =
		percent === null ? "no weekly reading" : `${percent}% of the week, ${age}`;
	return `${buildSeatName(seat)}: ${reading}, ${weekFull ? "weekly-full" : "not weekly-full"}`;
}

/**
 * @param {PlanSeatBasis[]} planSeats
 * @param {string[]} omitted
 * @param {{at: number, ageSuffix: string}} age
 */
const buildBasisLines = (planSeats, omitted, { at, ageSuffix }) => [
	...planSeats.map((b) => buildPlanSeatText(b, at, ageSuffix)),
	...(omitted.length > 0
		? [
				`credentials outside the seat file: ${omitted.map((d) => buildSeatName(d)).join(", ")}`,
			]
		: []),
];

/** @param {OverflowStart} start */
const buildOverflowStartLines = ({ at, planSeats, omitted }) =>
	buildBasisLines(planSeats, omitted, { at, ageSuffix: "before it" });

/**
 * The seat an overflow start was on, as a line names it.
 * @param {OverflowStart} start
 */
const buildStartLabel = (start) =>
	buildSeatLabel({ ...start, seat: buildSeatName(start.seat) });

module.exports = {
	buildBasisLines,
	buildOverflowStartLines,
	buildStartLabel,
	firstOverflowStart,
	parseOverflowStart,
	planSeatBasisOf,
};
