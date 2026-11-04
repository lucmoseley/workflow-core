/*
 * overflow-notice.js — the refill loop's record of the plan seats an overflow
 * launch or a move onto a key rested on, and the lines naming them (#3767). A
 * seat absent from the seat file is legitimate, so the overflow trigger cannot
 * refuse one: these lines are how a seat dropped by mistake is seen.
 */

const { describeAge } = require("./proc-table.js");
const { buildSeatName } = require("./refill-seats.js");

/**
 * @typedef {{seat: string, percent: number|null, weekReadAt: number|null,
 *   weekFull: boolean}} PlanSeatBasis a plan seat's weekly bar as read, whatever
 *   its trust, and 0 once its reset has passed; `weekReadAt` null where the
 *   reading has no time
 * @typedef {{at: number, seat: string, planSeats: PlanSeatBasis[],
 *   omitted: string[]}} OverflowStart `seat`, the overflow seat launched on;
 *   `omitted`, lib/refill-seats.js's readOmittedDirs at that launch
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
 *   relaunchedAt?: number}} StartedLaunch
 */

/**
 * Whether `l` runs on an overflow seat: launched on one, or moved onto its key
 * (#3736).
 * @param {Omit<StartedLaunch, "launchedAt">|undefined} l
 */
const isOnKey = (l) => l?.reason === "overflow" || l?.keyVar !== undefined;

/** When `l` last started on its seat: its launch, or a resume or move since.
 * @param {StartedLaunch} l */
const startedAt = (l) => Math.max(l.launchedAt, l.relaunchedAt ?? 0);

/**
 * The first of `launches` to start on an overflow seat after `since` whose
 * predecessor, the session started just before it, was on a plan seat, or
 * null.
 * @template {StartedLaunch} L
 * @param {L[]} launches the state's and the tick's own
 * @param {number} since the last overflow start recorded
 * @returns {L|null}
 */
function firstOverflowStart(launches, since) {
	/** @type {L|undefined} */
	let last;
	for (const l of [...launches].sort((x, y) => startedAt(x) - startedAt(y))) {
		if (isOnKey(l) && !isOnKey(last) && startedAt(l) > since) return l;
		last = l;
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
			: `read ${describeAge(Math.max(0, (at - weekReadAt) / 1000))} ${ageSuffix}`;
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

module.exports = {
	buildBasisLines,
	buildOverflowStartLines,
	firstOverflowStart,
	startedAt,
	parseOverflowStart,
	planSeatBasisOf,
};
